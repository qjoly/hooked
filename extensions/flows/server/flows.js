/*
 * Flow engine: runs a graph of stages (src/lib/flows.js), each stage a driven session, the way a
 * CI runner walks a pipeline. Templates live in flow-templates.json (the built-in "feature" one
 * is used until a stored template with the same id overrides it), runs in flow-runs.json. A run
 * keeps a snapshot of its flow, so editing a template never changes a run in progress.
 *
 * The engine is a 3 s tick that reads the registry (busy / waiting / alive) of each running
 * stage. A stage reports through the MCP tool `flow_report` (POST /api/flows op=report), and is
 * done once it has reported AND its turn has ended. A turn that ends without a report gets one
 * nudge, then the stage is `stalled` until the user steps in. Stage sessions are reused across
 * loop iterations, so each one keeps its context (and its prompt cache).
 *
 * Ownership: the service adopts every running run at boot (sessions are resumed by
 * resumeDrivenSessions, the engine waits a grace period before calling a missing one lost). A bare
 * `npm run live` only drives the runs it started itself: two processes walking the same run would
 * each resume the other's sessions.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOOKED_DIR } from '#server/config.js';
import {
  launchSession, deliverReply, interruptSession, agentAlive, agentBusy, agentPendingAsk, agentLastProse,
  sessionIdForLaunchKey, err400,
} from '#server/agent.js';
import { createWorktree, attachWorktreeSession, autoNameBranch } from '#server/worktrees.js';
import { renameGroup } from '#server/sessionMeta.js';
import { readTags, setTags } from '#server/tags.js';
import {
  FEATURE_TEMPLATE, VERDICTS, cleanFlow, validateFlow, readyStages, verdictOutcome, loopResetKeys,
  downstreamOf, stagePrompt, stageLoopPrompt, NUDGE_PROMPT,
} from '../lib/flows.js';

const TEMPLATES_FILE = path.join(HOOKED_DIR, 'flow-templates.json');
const RUNS_FILE = path.join(HOOKED_DIR, 'flow-runs.json');
const FLOW_TAG = 'flow';
const TICK_MS = 3000;
const LOST_GRACE_MS = 3 * 60 * 1000;  // boot: resumeDrivenSessions brings sessions back one by one
const MAX_LOG = 200;
const MAX_RUNS = 100;
// Sibling stages share the CLI's system + tools prefix (same model, same workspace). Starting them
// at the same instant makes each one write that prefix to the prompt cache; a few seconds apart,
// the second one reads what the first one wrote, at a tenth of the price.
const STAGGER_MS = 10_000;

const ENGINE = (globalThis[Symbol.for('hooked.flows.engine')] ??= {
  started: false, adopt: false, startedAt: Date.now(), owner: crypto.randomBytes(6).toString('hex'), inflight: new Set(),
});

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const nowIso = () => new Date().toISOString();

// ── Templates ───────────────────────────────────────────────────────────────────────────────────

function readStoredTemplates() {
  try {
    const list = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    return Array.isArray(list) ? list.map(cleanFlow).filter((t) => t.id) : [];
  } catch (_) {
    return [];
  }
}

function listFlowTemplates() {
  const stored = readStoredTemplates();
  const builtIn = stored.some((t) => t.id === FEATURE_TEMPLATE.id) ? [] : [{ ...cleanFlow(FEATURE_TEMPLATE), builtIn: true }];
  return [...builtIn, ...stored];
}

function saveFlowTemplate(raw) {
  const t = cleanFlow(raw);
  validateFlow(wrap400(t));
  const list = readStoredTemplates();
  if (!t.id) t.id = crypto.randomBytes(4).toString('hex');
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) list[i] = t; else list.push(t);
  writeJson(TEMPLATES_FILE, list);
  return t;
}

// Deleting the stored copy of the built-in template restores the original.
function deleteFlowTemplate(id) {
  const list = readStoredTemplates();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) throw err400(id === FEATURE_TEMPLATE.id ? 'the built-in template cannot be deleted' : 'template not found');
  writeJson(TEMPLATES_FILE, next);
}

function wrap400(flow) {
  try { return validateFlow(flow); } catch (e) { throw err400(e.message); }
}

// ── Runs storage ────────────────────────────────────────────────────────────────────────────────

function writeJson(file, data) {
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readRuns() {
  try {
    const list = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((r) => r && r.id && r.flow) : [];
  } catch (_) {
    return [];
  }
}

// Read-modify-write of one run. `fn` mutates it in place; returns the run (or null).
function mutateRun(id, fn) {
  const list = readRuns();
  const run = list.find((r) => r.id === id);
  if (!run) return null;
  fn(run);
  run.updatedAt = nowIso();
  writeJson(RUNS_FILE, list);
  return run;
}

function log(run, text) {
  run.log = [...(run.log || []), { at: nowIso(), text }].slice(-MAX_LOG);
}

function freshStage() {
  return { status: 'pending', sessionId: null, report: null, startedAt: null, endedAt: null, nudged: false, resumed: false };
}

// Runs as the UI shows them: stage states enriched with the registry's live view.
function listFlowRuns() {
  return readRuns().map(withLive).reverse();
}

function getFlowRun(id) {
  const r = readRuns().find((x) => x.id === id);
  return r ? withLive(r) : null;
}

function withLive(run) {
  const stages = {};
  for (const [k, st] of Object.entries(run.stages)) {
    const alive = st.sessionId ? agentAlive(st.sessionId) : false;
    stages[k] = {
      ...st,
      alive,
      busy: alive ? agentBusy(st.sessionId) === true : false,
      waiting: alive ? !!agentPendingAsk(st.sessionId) : false,
      starting: ENGINE.inflight.has(run.id + ':' + k),
    };
  }
  return { ...run, stages, managed: ENGINE.started && owns(run) };
}

// ── Starting a run ──────────────────────────────────────────────────────────────────────────────

function startFlowRun(opts, cb) {
  const o = opts && typeof opts === 'object' ? opts : {};
  let flow;
  try {
    const tpl = o.flow ? cleanFlow(o.flow) : listFlowTemplates().find((t) => t.id === o.templateId);
    if (!tpl) throw err400('template not found');
    flow = wrap400(cleanFlow(tpl));
  } catch (e) { return cb(e); }
  const task = typeof o.task === 'string' ? o.task.trim() : '';
  if (!task) return cb(err400('task required'));
  const cwd = str(o.cwd, 1024);
  const st = cwd && fs.statSync(cwd, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return cb(err400('not a directory: ' + (cwd || '(empty)')));
  const useWorktree = o.worktree === undefined ? flow.worktree : o.worktree !== false;
  startFlowEngine();

  const make = (dir, wt) => {
    const run = {
      id: crypto.randomBytes(5).toString('hex'),
      name: str(o.name, 80) || task.split('\n')[0].slice(0, 60),
      task,
      project: cwd,
      cwd: dir,
      worktree: wt ? { path: wt.path, branch: wt.branch, base: wt.base } : null,
      flow,
      status: 'running',
      iteration: 1,
      loopNote: null,
      note: null,
      owner: ENGINE.owner,
      mother: null,
      stages: Object.fromEntries(flow.stages.map((s) => [s.key, freshStage()])),
      history: [],
      log: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
    };
    log(run, wt ? `started in worktree ${wt.path}` : `started in ${dir}`);
    const list = readRuns();
    list.push(run);
    // Keep the newest runs; a finished run older than the cap only holds history.
    writeJson(RUNS_FILE, list.slice(-MAX_RUNS));
    flowTick();
    cb(null, { run: withLive(run), link: '/flows?run=' + run.id });
  };

  if (!useWorktree) return make(cwd, null);
  createWorktree({ cwd, base: o.base }).then((wt) => {
    if (wt.autoName) autoNameBranch(wt.path, task).catch(() => {});
    make(wt.path, wt);
  }, (e) => cb(err400('could not create the worktree: ' + ((e && e.message) || e) + ' (start without a worktree to run in the project directly)')));
}

// ── Engine ──────────────────────────────────────────────────────────────────────────────────────

const owns = (run) => ENGINE.adopt || run.owner === ENGINE.owner;
ENGINE.lastLaunch ??= new Map();

function startFlowEngine({ adopt = false } = {}) {
  if (adopt) ENGINE.adopt = true;
  if (ENGINE.started) return;
  ENGINE.started = true;
  ENGINE.startedAt = Date.now();
  // A launch cut off by a restart never recorded its session: start it again.
  for (const r of readRuns()) {
    if (r.status !== 'running' || !owns(r)) continue;
    if (Object.values(r.stages).some((s) => s.status === 'starting')) {
      mutateRun(r.id, (run) => { for (const s of Object.values(run.stages)) if (s.status === 'starting') s.status = 'pending'; });
    }
  }
  ENGINE.timer = setInterval(() => { try { flowTick(); } catch (e) { console.warn('[hooked] flow tick:', e.message || e); } }, TICK_MS);
  ENGINE.timer.unref?.();
}

// The extension was switched off: no more transitions. Runs keep their state and go on when the
// engine starts again (adopted by the service at its next start, or lazily by an op).
function stopFlowEngine() {
  clearInterval(ENGINE.timer);
  ENGINE.timer = null;
  ENGINE.started = false;
}

function flowTick() {
  for (const run of readRuns()) {
    if (run.status !== 'running' || !owns(run)) continue;
    for (const s of run.flow.stages) observeStage(run.id, s.key);
    const fresh = readRuns().find((r) => r.id === run.id);
    if (!fresh) continue;
    for (const s of readyStages(fresh)) {
      // A looped stage resumes its own session (its own cache): no need to wait for a sibling.
      if (!fresh.stages[s.key].sessionId) {
        if (Date.now() - (ENGINE.lastLaunch.get(fresh.id) || 0) < STAGGER_MS) continue;
        ENGINE.lastLaunch.set(fresh.id, Date.now());
      }
      launchStage(fresh, s);
    }
  }
}

// One stage of a running run: decide from the registry whether it is done, stalled or lost.
function observeStage(runId, key) {
  const snapshot = readRuns().find((r) => r.id === runId);
  const st = snapshot?.stages[key];
  if (!st || !st.sessionId || !['running', 'stalled', 'lost'].includes(st.status)) return;
  if (ENGINE.inflight.has(runId + ':' + key)) return;
  const sid = st.sessionId;
  const alive = agentAlive(sid);
  const busy = alive && agentBusy(sid) === true;
  const waiting = alive && !!agentPendingAsk(sid);

  if (st.report && !busy && !waiting) return finishStage(runId, key);
  if (alive) {
    if (busy || waiting) {
      if (st.status !== 'running') mutateRun(runId, (run) => { run.stages[key].status = 'running'; });
      return;
    }
    if (st.status === 'stalled') return;
    if (!st.nudged) {
      mutateRun(runId, (run) => { run.stages[key].nudged = true; log(run, `${key}: turn ended without a report, nudged`); });
      deliverReply(sid, NUDGE_PROMPT, () => {});
      return;
    }
    mutateRun(runId, (run) => { run.stages[key].status = 'stalled'; log(run, `${key}: stalled, waiting on you`); });
    return;
  }
  // Not alive here: give a restart time to bring it back, then resume it once.
  if (Date.now() - ENGINE.startedAt < LOST_GRACE_MS) return;
  if (st.status === 'lost') return;
  if (!st.resumed) {
    mutateRun(runId, (run) => { run.stages[key].resumed = true; log(run, `${key}: session gone, resuming it`); });
    relaunch(runId, key, sid, 'Continue. Your previous turn was cut off; finish your part of the flow and call `flow_report`.');
    return;
  }
  mutateRun(runId, (run) => { run.stages[key].status = 'lost'; log(run, `${key}: session lost`); });
}

function relaunch(runId, key, sid, prompt) {
  const k = runId + ':' + key;
  ENGINE.inflight.add(k);
  const run = readRuns().find((r) => r.id === runId);
  const stage = run?.flow.stages.find((s) => s.key === key);
  // No `model` on a resume: the CLI restores the transcript's, forcing one would empty the cache.
  launchSession({ resumeId: sid, prompt, effort: stage?.effort || undefined }, (err) => {
    ENGINE.inflight.delete(k);
    mutateRun(runId, (r) => {
      if (err) { r.stages[key].status = 'lost'; log(r, `${key}: could not resume (${err.message || err})`); }
      else r.stages[key].status = 'running';
    });
  });
}

function finishStage(runId, key) {
  mutateRun(runId, (run) => {
    const st = run.stages[key];
    st.status = 'done';
    st.endedAt = nowIso();
    log(run, `${key}: done${st.report?.verdict ? ` (${st.report.verdict})` : ''}`);
    const out = verdictOutcome(run, key, st.report?.verdict);
    if (!out) {
      // No decider: the run ends with its last stage.
      if (Object.values(run.stages).every((s) => s.status === 'done')) {
        run.status = 'done';
        run.finishedAt = nowIso();
        log(run, 'all stages done');
      }
      return;
    }
    if (out.note) log(run, out.note);
    if (out.status === 'running' && out.reset) {
      run.iteration = out.iteration;
      run.loopNote = { from: 'the decider', summary: st.report.summary };
      resetStages(run, out.reset);
    } else {
      run.status = out.status;
      run.note = out.note;
      if (out.status === 'done') run.finishedAt = nowIso();
    }
  });
}

function resetStages(run, keys) {
  run.rerun = [...keys];
  for (const k of keys) {
    const prev = run.stages[k];
    run.stages[k] = { ...freshStage(), sessionId: prev.sessionId };
  }
}

function launchStage(run, stage) {
  const k = run.id + ':' + stage.key;
  if (ENGINE.inflight.has(k)) return;
  const prevSid = run.stages[stage.key].sessionId;
  ENGINE.inflight.add(k);
  mutateRun(run.id, (r) => {
    Object.assign(r.stages[stage.key], { status: 'starting', startedAt: nowIso(), nudged: false, resumed: false });
  });
  const done = (err, sid) => {
    ENGINE.inflight.delete(k);
    mutateRun(run.id, (r) => {
      const st = r.stages[stage.key];
      if (err) {
        st.status = 'pending';
        r.status = 'needs-you';
        r.note = `${stage.name} could not start: ${err.message || err}`;
        log(r, r.note);
        return;
      }
      st.status = 'running';
      st.sessionId = sid;
      log(r, `${stage.key}: ${prevSid ? 'iteration ' + r.iteration : 'started'}`);
      if (!r.mother) r.mother = sid;
    });
  };

  // Back to a stage that already ran: same session, so it keeps its context.
  if (prevSid) {
    const prompt = stageLoopPrompt(run, stage);
    if (agentAlive(prevSid)) return deliverReply(prevSid, prompt, (err) => done(err, prevSid));
    return launchSession({ resumeId: prevSid, prompt, effort: stage.effort || undefined }, (err) => done(err, prevSid));
  }
  launchSession({
    cwd: run.cwd,
    prompt: stagePrompt(run, stage),
    model: stage.model || undefined,
    effort: stage.effort || undefined,
    permissionMode: stage.permissionMode || 'default',
    groupWith: run.mother || undefined,
  }, (err, info) => {
    if (err) return done(err);
    const sid = info.sessionId;
    try { setTags(sid, [...new Set([...(readTags()[sid] || []), FLOW_TAG])]); } catch (_) {}
    if (run.worktree) { try { attachWorktreeSession(run.worktree.path, sid); } catch (_) {} }
    if (!run.mother) { try { renameGroup(sid, 'Flow · ' + run.name); } catch (_) {} }
    done(null, sid);
  });
}

// ── Stage reports (MCP flow_report) ─────────────────────────────────────────────────────────────

function reportFlowStage({ launchKey, sessionId, summary, verdict } = {}) {
  const sid = sessionId || sessionIdForLaunchKey(launchKey);
  if (!sid) throw err400('only a session driven by hooked can report to a flow');
  const text = typeof summary === 'string' ? summary.trim().slice(0, 20000) : '';
  if (!text) throw err400('summary required');
  const found = readRuns().find((r) => Object.values(r.stages).some((s) => s.sessionId === sid && ['running', 'stalled', 'lost', 'starting'].includes(s.status)));
  if (!found) throw err400('this session is not an active stage of a flow');
  const key = Object.keys(found.stages).find((k) => found.stages[k].sessionId === sid);
  const stage = found.flow.stages.find((s) => s.key === key);
  const v = verdict ? String(verdict).trim().toLowerCase() : null;
  if (v && !VERDICTS.includes(v)) throw err400('verdict must be one of ' + VERDICTS.join(', '));
  if (stage.decider && !v) throw err400('the decider must give a verdict: done, loop or escalate');
  if (!stage.decider && v === 'loop') throw err400('only the decider stage can loop');
  mutateRun(found.id, (run) => {
    run.stages[key].report = { summary: text, verdict: v, at: nowIso() };
    run.history = [...(run.history || []), { iteration: run.iteration, stage: key, summary: text, verdict: v, at: nowIso() }];
    log(run, `${key}: reported${v ? ' ' + v : ''}`);
  });
  return { run: found.id, stage: key, message: 'Report recorded. End your turn now; hooked moves the flow on once it ends.' };
}

// ── User actions ────────────────────────────────────────────────────────────────────────────────

function needRun(id) {
  const r = readRuns().find((x) => x.id === id);
  if (!r) throw err400('run not found');
  return r;
}

function stopFlowRun(id) {
  const run = needRun(id);
  for (const st of Object.values(run.stages)) {
    if (st.sessionId && ['running', 'starting'].includes(st.status) && agentBusy(st.sessionId)) interruptSession(st.sessionId, () => {});
  }
  return mutateRun(id, (r) => { r.status = 'stopped'; r.finishedAt = nowIso(); log(r, 'stopped by you'); });
}

function finishFlowRun(id) {
  needRun(id);
  return mutateRun(id, (r) => { r.status = 'done'; r.finishedAt = nowIso(); log(r, 'closed by you'); });
}

// Resumes a run that was waiting on the user (escalation, loop cap, failed start). Stages that
// already reported keep their report; the engine picks up from there.
function continueFlowRun(id) {
  const run = needRun(id);
  if (Object.values(run.stages).every((s) => s.status === 'done')) throw err400('nothing left to run: loop again or close the run');
  startFlowEngine();
  const r = mutateRun(id, (run) => { run.status = 'running'; run.note = null; run.finishedAt = null; run.owner = ENGINE.owner; log(run, 'resumed by you'); });
  flowTick();
  return r;
}

// Runs `key` and everything after it again. `loop: true` counts as a new iteration (what the
// decider's `loop` does); `note` is handed to every re-run stage as instructions.
function rerunFlowStage(id, key, { note, loop = false } = {}) {
  const run = needRun(id);
  const stage = run.flow.stages.find((s) => s.key === key);
  if (!stage) throw err400('unknown stage');
  for (const k of [key, ...downstreamOf(run.flow.stages, key)]) {
    if (ENGINE.inflight.has(id + ':' + k)) throw err400(`stage ${k} is starting`);
    const sid = run.stages[k].sessionId;
    if (sid && agentBusy(sid) && !run.stages[k].report) throw err400(`stage ${k} is still working`);
  }
  startFlowEngine();
  const text = typeof note === 'string' ? note.trim() : '';
  const r = mutateRun(id, (rr) => {
    if (loop) {
      rr.iteration += 1;
      if (rr.iteration > rr.flow.maxLoops + 1) rr.flow.maxLoops = rr.iteration - 1;
      const decider = rr.flow.stages.find((s) => s.decider);
      const fromDecider = decider && rr.stages[decider.key].report?.summary;
      rr.loopNote = { from: text ? 'the user' : 'the decider', summary: text || fromDecider || 'Do another pass.' };
    } else if (text) {
      rr.loopNote = { from: 'the user', summary: text };
    }
    resetStages(rr, loop ? loopResetKeys(rr.flow, key) : [key, ...downstreamOf(rr.flow.stages, key)]);
    rr.status = 'running';
    rr.note = null;
    rr.finishedAt = null;
    rr.owner = ENGINE.owner;
    log(rr, loop ? `iteration ${rr.iteration} requested by you, back to ${key}` : `${key} re-run by you`);
  });
  flowTick();
  return r;
}

// A stalled or lost stage the user settles by hand: its last message stands for the report.
function markFlowStageDone(id, key, { summary, verdict } = {}) {
  const run = needRun(id);
  const st = run.stages[key];
  if (!st) throw err400('unknown stage');
  const text = (typeof summary === 'string' && summary.trim())
    || (st.sessionId && agentLastProse(st.sessionId))
    || 'Marked done by the user.';
  const stage = run.flow.stages.find((s) => s.key === key);
  const v = stage.decider ? (VERDICTS.includes(verdict) ? verdict : 'done') : null;
  mutateRun(id, (r) => {
    r.stages[key].report = { summary: text, verdict: v, at: nowIso(), byUser: true };
    r.history = [...(r.history || []), { iteration: r.iteration, stage: key, summary: text, verdict: v, at: nowIso(), byUser: true }];
    if (r.status !== 'running') { r.status = 'running'; r.note = null; }
    r.owner = ENGINE.owner;
    log(r, `${key}: marked done by you`);
  });
  startFlowEngine();
  finishStage(id, key);
  flowTick();
  return getFlowRun(id);
}

function deleteFlowRun(id) {
  const list = readRuns();
  const run = list.find((r) => r.id === id);
  if (!run) throw err400('run not found');
  if (run.status === 'running') throw err400('stop the run before deleting it');
  writeJson(RUNS_FILE, list.filter((r) => r.id !== id));
}

export {
  TEMPLATES_FILE as FLOW_TEMPLATES_FILE, RUNS_FILE as FLOW_RUNS_FILE,
  listFlowTemplates, saveFlowTemplate, deleteFlowTemplate,
  listFlowRuns, getFlowRun, startFlowRun, startFlowEngine, stopFlowEngine, flowTick,
  reportFlowStage, stopFlowRun, finishFlowRun, continueFlowRun, rerunFlowStage, markFlowStageDone, deleteFlowRun,
};
