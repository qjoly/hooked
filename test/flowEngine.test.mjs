// The flow engine walked end to end with a fake agent registry: launches, reports, turn ends,
// the decider's loop and the nudge of a stage that forgets to report.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-flows-'));
process.env.HOOKED_DATA_DIR = dir;

// Fake registry: session id → { busy, waiting, prose }.
const sessions = new Map();
const launches = [];
const replies = [];
let seq = 0;
vi.mock('../server/agent.js', () => ({
  launchSession: (opts, cb) => {
    const id = opts.resumeId || 'sess-' + ++seq;
    sessions.set(id, { busy: !!opts.prompt, waiting: false, key: 'key-' + id });
    launches.push({ id, ...opts });
    cb(null, { sessionId: id });
  },
  deliverReply: (id, text, cb) => { replies.push({ id, text }); sessions.get(id).busy = true; cb(null); },
  interruptSession: (id, cb) => { sessions.get(id).busy = false; cb(null); },
  agentAlive: (id) => sessions.has(id),
  agentBusy: (id) => (sessions.has(id) ? sessions.get(id).busy : null),
  agentPendingAsk: (id) => (sessions.get(id)?.waiting ? { kind: 'question' } : null),
  agentLastProse: () => 'last words',
  sessionIdForLaunchKey: (k) => [...sessions].find(([, s]) => s.key === k)?.[0] || null,
  err400: (m) => Object.assign(new Error(m), { code: 400 }),
}));
vi.mock('../server/worktrees.js', () => ({ createWorktree: vi.fn(), attachWorktreeSession: () => {}, autoNameBranch: async () => {} }));
vi.mock('../server/sessionMeta.js', () => ({ renameGroup: () => {} }));
vi.mock('../server/tags.js', () => ({ readTags: () => ({}), setTags: () => {} }));

let F;
beforeAll(async () => { F = await import('../server/flows.js'); });

const start = () => new Promise((res, rej) => F.startFlowRun(
  { templateId: 'feature', task: 'Add a toggle', cwd: dir, worktree: false },
  (e, info) => (e ? rej(e) : res(info.run.id)),
));
const run = (id) => F.getFlowRun(id);
const sid = (id, key) => run(id).stages[key].sessionId;
// A stage reports and its turn ends; the next tick moves the flow on.
const ENGINE = () => globalThis[Symbol.for('hooked.flows.engine')];
// Ticks as if the stagger window had passed.
function tick() { ENGINE().lastLaunch.clear(); F.flowTick(); }
function complete(id, key, verdict, summary = key.toUpperCase() + '-REPORT') {
  const s = sid(id, key);
  F.reportFlowStage({ launchKey: sessions.get(s).key, summary, verdict });
  sessions.get(s).busy = false;
  tick();
  tick();
}

describe('flow engine', () => {
  it('walks the feature pipeline, loops once, then closes', async () => {
    const id = await start();
    expect(run(id).stages.pilot.status).toBe('running');
    expect(launches.at(-1).prompt).toContain('**Pilot**');

    complete(id, 'pilot');
    expect(run(id).stages.build.status).toBe('running');
    expect(launches.at(-1).prompt).toContain('PILOT-REPORT');
    expect(launches.at(-1).permissionMode).toBe('acceptEdits');
    expect(launches.at(-1).groupWith).toBe(sid(id, 'pilot'));

    complete(id, 'build');
    expect(run(id).stages.review.status).toBe('running');
    expect(run(id).stages.challenge.status).toBe('running');

    complete(id, 'review');
    expect(run(id).stages.decide.status).toBe('pending'); // waits for the challenger
    complete(id, 'challenge');
    expect(run(id).stages.decide.status).toBe('running');

    const builder = sid(id, 'build');
    complete(id, 'decide', 'loop', 'FIX-IT');
    let r = run(id);
    expect(r.iteration).toBe(2);
    expect(r.stages.pilot.status).toBe('done');
    expect(r.stages.build.status).toBe('running');
    expect(r.stages.build.sessionId).toBe(builder);           // same session, keeps its context
    expect(replies.at(-1)).toMatchObject({ id: builder });
    expect(replies.at(-1).text).toContain('FIX-IT');
    expect(replies.at(-1).text).not.toContain('PILOT-REPORT'); // already in the builder's context

    complete(id, 'build', undefined, 'BUILD-PASS-2');
    const toReviewer = replies.filter((r) => r.id === sid(id, 'review')).at(-1).text;
    expect(toReviewer).toContain('BUILD-PASS-2');
    expect(toReviewer).not.toContain('PILOT-REPORT');
    complete(id, 'review');
    complete(id, 'challenge');
    complete(id, 'decide', 'done', 'ALL GOOD');
    r = run(id);
    expect(r.status).toBe('done');
    expect(r.history.filter((h) => h.stage === 'build')).toHaveLength(2);
  });

  it('staggers sibling stages so the second one reads the cached prefix', async () => {
    const id = await start();
    complete(id, 'pilot');
    const s = sid(id, 'build');
    F.reportFlowStage({ launchKey: sessions.get(s).key, summary: 'b' });
    sessions.get(s).busy = false;
    tick();
    const started = () => ['review', 'challenge'].filter((k) => run(id).stages[k].sessionId);
    expect(started()).toHaveLength(1);
    F.flowTick();
    expect(started()).toHaveLength(1);
    tick();
    expect(started()).toHaveLength(2);
    F.stopFlowRun(id);
  });

  it('does not finish a stage that reported until its turn ends', async () => {
    const id = await start();
    const s = sid(id, 'pilot');
    F.reportFlowStage({ launchKey: sessions.get(s).key, summary: 'x' });
    F.flowTick();
    expect(run(id).stages.pilot.status).toBe('running');
    sessions.get(s).busy = false;
    tick();
    expect(run(id).stages.pilot.status).toBe('done');
    F.stopFlowRun(id);
  });

  it('nudges a stage that ends its turn without reporting, then marks it stalled', async () => {
    const id = await start();
    const s = sid(id, 'pilot');
    sessions.get(s).busy = false;
    F.flowTick();
    expect(replies.at(-1).text).toContain('flow_report');
    expect(run(id).stages.pilot.nudged).toBe(true);
    sessions.get(s).busy = false;
    F.flowTick();
    expect(run(id).stages.pilot.status).toBe('stalled');
    F.markFlowStageDone(id, 'pilot');
    tick();
    expect(run(id).stages.pilot.report.summary).toBe('last words');
    expect(run(id).stages.build.status).toBe('running');
    F.stopFlowRun(id);
  });

  it('enforces verdict rules on reports', async () => {
    const id = await start();
    const key = sessions.get(sid(id, 'pilot')).key;
    expect(() => F.reportFlowStage({ launchKey: key, summary: 'x', verdict: 'loop' })).toThrow(/only the decider/);
    expect(() => F.reportFlowStage({ launchKey: 'nope', summary: 'x' })).toThrow(/driven by hooked/);
    F.stopFlowRun(id);
  });

  it('hands the run to the user at the loop cap, and Loop again lifts it', async () => {
    const id = await start();
    for (const k of ['pilot', 'build', 'review', 'challenge']) complete(id, k);
    for (let i = 0; i < 3; i++) {
      complete(id, 'decide', 'loop');
      for (const k of ['build', 'review', 'challenge']) complete(id, k);
    }
    complete(id, 'decide', 'loop');
    expect(run(id).status).toBe('needs-you');
    expect(run(id).iteration).toBe(4);
    F.rerunFlowStage(id, 'build', { loop: true, note: 'one more' });
    const r = run(id);
    expect(r.status).toBe('running');
    expect(r.iteration).toBe(5);
    expect(r.stages.build.status).toBe('running');
    expect(replies.at(-1).text).toContain('one more');
    F.stopFlowRun(id);
  });
});
