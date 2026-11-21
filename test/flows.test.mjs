import { describe, it, expect } from 'vitest';
import {
  FEATURE_TEMPLATE, cleanFlow, validateFlow, depths, columns, downstreamOf, upstreamOf, readyStages,
  verdictOutcome, loopResetKeys, stagePrompt, stageLoopPrompt, runBadge,
} from '../src/lib/flows.js';

const feature = () => validateFlow(cleanFlow(FEATURE_TEMPLATE));
const runOf = (flow, statuses = {}, extra = {}) => ({
  name: 'Add dark mode', task: 'Add a dark mode toggle', cwd: '/tmp/wt', worktree: { path: '/tmp/wt' },
  flow, status: 'running', iteration: 1, loopNote: null,
  stages: Object.fromEntries(flow.stages.map((s) => [s.key, { status: statuses[s.key] || 'pending', report: null }])),
  ...extra,
});

describe('validateFlow', () => {
  it('accepts the built-in feature template', () => {
    expect(() => feature()).not.toThrow();
  });

  const base = (stages, extra = {}) => cleanFlow({ name: 'x', stages, ...extra });
  const st = (key, after = [], o = {}) => ({ key, name: key, role: 'r', after, ...o });

  it('rejects unknown dependencies, cycles and duplicate keys', () => {
    expect(() => validateFlow(base([st('a', ['zz'])]))).toThrow(/unknown stage/);
    expect(() => validateFlow(base([st('a', ['b']), st('b', ['a'])]))).toThrow(/cycle/);
    expect(() => validateFlow(base([st('a'), st('a')]))).toThrow(/duplicate/);
    expect(() => validateFlow(base([st('A b')]))).toThrow(/invalid stage key/);
  });

  it('requires a role per stage', () => {
    expect(() => validateFlow(base([{ key: 'a', after: [] }]))).toThrow(/role/);
  });

  it('constrains the decider: one, last, looping to an upstream stage', () => {
    expect(() => validateFlow(base([st('a'), st('d', ['a'], { decider: true })]))).toThrow(/loop back/);
    expect(() => validateFlow(base([st('a'), st('b'), st('d', ['a'], { decider: true, loopTo: 'b' })]))).toThrow(/before the decider/);
    expect(() => validateFlow(base([st('a'), st('d', ['a'], { decider: true, loopTo: 'a' }), st('z', ['d'])]))).toThrow(/last stage/);
    expect(() => validateFlow(base([st('a'), st('d', ['a'], { decider: true, loopTo: 'a' }), st('e', ['a'], { decider: true, loopTo: 'a' })]))).toThrow(/only one decider/);
  });
});

describe('graph helpers', () => {
  it('lays the feature template out as a pipeline with a parallel column', () => {
    const f = feature();
    expect(Object.fromEntries(depths(f.stages))).toEqual({ pilot: 0, build: 1, review: 2, challenge: 2, decide: 3 });
    expect(columns(f.stages).map((c) => c.map((s) => s.key))).toEqual([['pilot'], ['build'], ['review', 'challenge'], ['decide']]);
  });

  it('walks upstream and downstream', () => {
    const f = feature();
    expect([...downstreamOf(f.stages, 'build')].sort()).toEqual(['challenge', 'decide', 'review']);
    expect([...upstreamOf(f.stages, 'decide')].sort()).toEqual(['build', 'challenge', 'pilot', 'review']);
    expect(loopResetKeys(f, 'build').sort()).toEqual(['build', 'challenge', 'decide', 'review']);
  });
});

describe('readyStages', () => {
  it('starts roots first, then parallel stages together, then the join', () => {
    const f = feature();
    expect(readyStages(runOf(f)).map((s) => s.key)).toEqual(['pilot']);
    expect(readyStages(runOf(f, { pilot: 'done', build: 'done' })).map((s) => s.key)).toEqual(['review', 'challenge']);
    expect(readyStages(runOf(f, { pilot: 'done', build: 'done', review: 'done', challenge: 'running' })).map((s) => s.key)).toEqual([]);
    expect(readyStages(runOf(f, { pilot: 'done', build: 'done', review: 'done', challenge: 'done' })).map((s) => s.key)).toEqual(['decide']);
  });

  it('starts nothing unless the run is running', () => {
    expect(readyStages(runOf(feature(), {}, { status: 'needs-you' }))).toEqual([]);
  });
});

describe('verdictOutcome', () => {
  it('loops back to build and resets everything downstream', () => {
    const out = verdictOutcome(runOf(feature()), 'decide', 'loop');
    expect(out.status).toBe('running');
    expect(out.iteration).toBe(2);
    expect(out.reset.sort()).toEqual(['build', 'challenge', 'decide', 'review']);
  });

  it('stops at the loop cap and hands the run to the user', () => {
    const f = feature();
    expect(verdictOutcome(runOf(f, {}, { iteration: f.maxLoops + 1 }), 'decide', 'loop').status).toBe('needs-you');
    expect(verdictOutcome(runOf(f, {}, { iteration: f.maxLoops }), 'decide', 'loop').status).toBe('running');
  });

  it('closes on done, escalates from any stage, ignores non-decider reports', () => {
    const r = runOf(feature());
    expect(verdictOutcome(r, 'decide', 'done').status).toBe('done');
    expect(verdictOutcome(r, 'review', 'escalate').status).toBe('needs-you');
    expect(verdictOutcome(r, 'review', null)).toBeNull();
  });
});

describe('prompts', () => {
  it('hands a stage its role, the task and the upstream reports only', () => {
    const f = feature();
    const r = runOf(f, { pilot: 'done', build: 'done' });
    r.stages.pilot.report = { summary: 'SPEC-TEXT' };
    r.stages.build.report = { summary: 'BUILD-TEXT' };
    r.stages.challenge.report = { summary: 'SIBLING-TEXT' };
    const p = stagePrompt(r, f.stages.find((s) => s.key === 'review'));
    expect(p).toContain('**Review**');
    expect(p).toContain('Add a dark mode toggle');
    expect(p).toContain('SPEC-TEXT');
    expect(p).toContain('BUILD-TEXT');
    expect(p).not.toContain('SIBLING-TEXT');
    expect(p).toContain('flow_report');
    expect(p).toContain('do not modify tracked files');
  });

  it('asks the decider for a verdict', () => {
    const f = feature();
    expect(stagePrompt(runOf(f), f.stages.find((s) => s.key === 'decide'))).toMatch(/verdict/);
  });

  it('gives a looped stage the decider instructions', () => {
    const f = feature();
    const r = runOf(f, { pilot: 'done' }, { iteration: 2, loopNote: { from: 'the decider', summary: 'FIX-THE-NULL-CHECK' } });
    const p = stageLoopPrompt(r, f.stages.find((s) => s.key === 'build'));
    expect(p).toContain('Iteration 2');
    expect(p).toContain('FIX-THE-NULL-CHECK');
  });
});

describe('runBadge', () => {
  it('flags a run with a stalled stage as needing the user', () => {
    expect(runBadge(runOf(feature(), { pilot: 'stalled' }))[0]).toBe('needs you');
    expect(runBadge(runOf(feature()))[0]).toBe('running');
    expect(runBadge({ ...runOf(feature()), status: 'done' })[0]).toBe('done');
  });
});
