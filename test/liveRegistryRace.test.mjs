/*
 * The live registry is keyed by session id, and a restart puts a NEW entry under the id of the one
 * it is replacing: restartSession aborts the old process, then relaunches once it has exited. The old
 * entry's readLoop ends whenever its CLI process has finished exiting, which after a real turn can
 * be later than that. It must then clean up after itself only, never the entry that took its place:
 * deleting by id alone dropped the restarted session from the registry, leaving a CLI running that
 * hooked could neither drive nor see.
 */
import { describe, it, expect } from 'vitest';
import { readLoop, waitForExit, failStartup, agentSession, agentAlive, subscribeAgent, clearAgentState } from '../server/agent.js';

const SESSION = '11111111-2222-3333-4444-555555555555';
const tick = () => new Promise((r) => setTimeout(r, 0));
const gate = () => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; };

// A registry entry whose stream announces the session, then stays open until its gate is opened.
function entry(g) {
  const st = {
    id: null, launchKey: 'k-' + Math.random().toString(36).slice(2), cwd: '/tmp/x',
    input: { close() {} }, abort: { abort() {} }, watchdog: null, readyWaiters: [],
  };
  st.q = (async function* () {
    yield { type: 'system', subtype: 'hook_started', session_id: SESSION };
    await g.promise;
  })();
  return st;
}

// The state of a restart: the old entry is still winding down when the new one is registered.
async function restartInProgress() {
  clearAgentState();
  const oldGate = gate(), newGate = gate();
  const oldSt = entry(oldGate), newSt = entry(newGate);
  const oldDone = readLoop(oldSt);
  await tick();
  expect(agentSession(SESSION)).toBe(oldSt);
  const newDone = readLoop(newSt);
  await tick();
  expect(agentSession(SESSION)).toBe(newSt);
  return { oldSt, newSt, oldGate, newGate, oldDone, newDone };
}

describe('readLoop — an entry that ends after being replaced', () => {
  it('leaves the entry that replaced it in the registry', async () => {
    const { oldSt, newSt, oldGate, oldDone } = await restartInProgress();
    oldGate.open();
    await oldDone;
    expect(oldSt.ended).toBe(true);
    expect(agentSession(SESSION)).toBe(newSt);
    expect(agentAlive(SESSION)).toBe(true);
  });

  it('still removes the replacement when its own stream ends', async () => {
    const { newSt, oldGate, newGate, oldDone, newDone } = await restartInProgress();
    oldGate.open();
    await oldDone;
    newGate.open();
    await newDone;
    expect(newSt.ended).toBe(true);
    expect(agentAlive(SESSION)).toBe(false);
  });

  it('removes an entry nobody replaced, as before', async () => {
    clearAgentState();
    const g = gate();
    const st = entry(g);
    const done = readLoop(st);
    await tick();
    expect(agentAlive(SESSION)).toBe(true);
    g.open();
    await done;
    expect(agentAlive(SESSION)).toBe(false);
  });

  it('does not tell the viewers of the id that the session ended: it did not', async () => {
    const { oldGate, oldDone } = await restartInProgress();
    const seen = [];
    const off = subscribeAgent(SESSION, (snap) => seen.push(snap));
    oldGate.open();
    await oldDone;
    off();
    expect(seen.filter((s) => s.ended)).toEqual([]);
  });

  it('still tells them when the session really ended', async () => {
    clearAgentState();
    const g = gate();
    const st = entry(g);
    const done = readLoop(st);
    await tick();
    const seen = [];
    const off = subscribeAgent(SESSION, (snap) => seen.push(snap));
    g.open();
    await done;
    off();
    expect(seen.some((s) => s.ended)).toBe(true);
  });
});

describe('failStartup — an entry that fails after being replaced', () => {
  it('leaves the entry that replaced it in the registry', async () => {
    const { oldSt, newSt } = await restartInProgress();
    failStartup(oldSt);
    expect(oldSt.ended).toBe(true);
    expect(agentSession(SESSION)).toBe(newSt);
  });

  it('removes an entry nobody replaced, as before', async () => {
    clearAgentState();
    const g = gate();
    const st = entry(g);
    readLoop(st);
    await tick();
    failStartup(st);
    expect(agentAlive(SESSION)).toBe(false);
  });
});

describe('waitForExit — a restart waits for the old CLI to be gone', () => {
  const withWaiters = (st) => Object.assign(st, { exitWaiters: [], exitSettled: false });
  const pendingState = (p) => { let state = 'pending'; p.then(() => { state = 'done'; }); return () => state; };

  it('resolves when the stream of the entry ends, not before', async () => {
    clearAgentState();
    const g = gate();
    const st = withWaiters(entry(g));
    const done = readLoop(st);
    await tick();
    const state = pendingState(waitForExit(st, { capMs: 5000 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(state()).toBe('pending');
    g.open();
    await done;
    await tick();
    expect(state()).toBe('done');
  });

  it('resolves at once for an entry that has already exited', async () => {
    clearAgentState();
    const g = gate();
    const st = withWaiters(entry(g));
    const done = readLoop(st);
    await tick();
    g.open();
    await done;
    const t0 = Date.now();
    await waitForExit(st, { capMs: 5000 });
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('gives up after the cap on a CLI that will not leave', async () => {
    clearAgentState();
    const st = withWaiters(entry(gate()));
    readLoop(st);
    await tick();
    const t0 = Date.now();
    await waitForExit(st, { capMs: 60 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it('falls back to a short delay for an entry with no stream to wait for', async () => {
    const t0 = Date.now();
    await waitForExit({ q: null }, { capMs: 5000, fallbackMs: 40 });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(30);
    expect(waited).toBeLessThan(1000);
  });

  it('is released by failStartup too', async () => {
    clearAgentState();
    const st = withWaiters(entry(gate()));
    readLoop(st);
    await tick();
    const state = pendingState(waitForExit(st, { capMs: 5000 }));
    failStartup(st);
    await tick();
    expect(state()).toBe('done');
  });
});
