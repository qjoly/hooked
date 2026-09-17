/*
 * Where a driven session gets its id from (server/agent.js, readLoop).
 *
 * A prompt starting with a slash command delays `system/init` until the command has been handled —
 * minutes for `/code-review <pr url>`. The id has to come from the first message that carries one,
 * or the session stays out of `live`: not drivable, absent from the snapshot, and the launch
 * request times out while the CLI works on.
 */
import { describe, it, expect } from 'vitest';
import { readLoop, clearAgentState, agentAlive } from '../server/agent.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

// Minimal registry entry: what readLoop touches, nothing more.
function fakeEntry(messages) {
  return {
    id: null,
    launchKey: 'k',
    cwd: '/tmp/x',
    input: { close() {} },
    abort: { abort() {} },
    watchdog: null,
    readyWaiters: [],
    q: (async function* () { for (const m of messages) yield m; })(),
  };
}

describe('readLoop — session id', () => {
  it('takes it from a hook message, well before system/init', async () => {
    clearAgentState();
    const st = fakeEntry([
      { type: 'system', subtype: 'hook_started', session_id: SESSION },
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'opus', cwd: '/tmp/x' },
    ]);
    const seen = [];
    st.onId = (s) => seen.push(['id', s.id]);
    st.onInit = (s) => seen.push(['init', s.model]);

    await readLoop(st);

    expect(st.id).toBe(SESSION);
    expect(seen).toEqual([['id', SESSION], ['init', 'opus']]);
  });

  it('makes the session drivable from that first message on', async () => {
    clearAgentState();
    let aliveAtFirstMessage = null;
    const st = fakeEntry((async function* () {})());
    st.q = (async function* () {
      yield { type: 'system', subtype: 'hook_started', session_id: SESSION };
      aliveAtFirstMessage = agentAlive(SESSION);
      yield { type: 'system', subtype: 'init', session_id: SESSION };
    })();

    await readLoop(st);
    expect(aliveAtFirstMessage).toBe(true);
  });

  it('never overwrites the id of a resumed session', async () => {
    clearAgentState();
    const st = fakeEntry([{ type: 'system', subtype: 'init', session_id: 'other-id' }]);
    st.id = SESSION;
    await readLoop(st);
    expect(st.id).toBe(SESSION);
  });
});
