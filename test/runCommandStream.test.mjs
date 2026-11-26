/*
 * Run on a command Claude proposed: the output is shown while the command runs, not only once it
 * has exited. The server hands each chunk to `onOutput` (server/agent.js → runLocalCommand),
 * /api/run-command streams it as NDJSON, and the code block renders the accumulated log as a
 * terminal would (src/lib/format.js → liveLogText).
 *
 * The run itself goes through a registry entry built by hand, as in phantomSession.test.mjs, and a
 * pre-resolved login environment, so no Claude session and no login shell are started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import os from 'node:os';
import { liveLogText } from '../src/lib/format.js';

globalThis[Symbol.for('hooked.agent.loginEnv')] = Promise.resolve({ PATH: process.env.PATH });

const live = () => globalThis[Symbol.for('hooked.agent.registry')];
const ID = 'run-command-stream-test';

// Imported once the login environment above is in place: agent.js warms it up at import.
let agent, route;
beforeAll(async () => {
  agent = await import('../server/agent.js');
  route = await import('../src/routes/api/run-command/+server.js');
});
afterEach(() => live().delete(ID));

function session() {
  const st = {
    id: ID, launchKey: 'launch:test', cwd: os.tmpdir(), input: agent.makeInputQueue(), q: {},
    abort: new AbortController(), sawMsg: true, watchdog: null, ended: false,
    busy: false, activity: null, sdkState: 'idle', pendingAsk: null,
  };
  live().set(ID, st);
  return st;
}

function run(command) {
  const chunks = [];
  return new Promise((resolve) => {
    agent.deliverReply(ID, '!' + command, (err, info) => resolve({ err, info, chunks }), {
      respond: true,
      onOutput: (text) => chunks.push({ text, at: Date.now() }),
    });
  });
}

describe('runLocalCommand — live output', () => {
  it('hands the output over while the command is still running', async () => {
    session();
    const { err, info, chunks } = await run('printf "a\\n"; sleep 0.4; printf "b\\n"');
    expect(err).toBe(null);
    expect(chunks.map((c) => c.text).join('')).toBe('a\nb\n');
    // `a` was printed 400 ms before `b`: it must have arrived on its own, ahead of the end.
    expect(chunks[0].text).toBe('a\n');
    expect(chunks.at(-1).at - chunks[0].at).toBeGreaterThanOrEqual(300);
    expect(info.localCommand.output).toBe('a\nb\n');
  });

  it('strips ANSI sequences from the live chunks', async () => {
    session();
    const { chunks } = await run('printf "\\033[31mred\\033[0m\\n"');
    expect(chunks.map((c) => c.text).join('')).toBe('red\n');
  });

  it('merges stderr into the live output, as a terminal does', async () => {
    session();
    const { chunks } = await run('echo oops >&2');
    expect(chunks.map((c) => c.text).join('')).toBe('oops\n');
  });
});

describe('POST /api/run-command', () => {
  const post = (body) => route.POST({
    request: new Request('http://x/api/run-command', { method: 'POST', body: JSON.stringify(body) }),
  });

  async function readLines(res) {
    const lines = [];
    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of res.body) {
      const parts = (pending + decoder.decode(bytes, { stream: true })).split('\n');
      pending = parts.pop();
      for (const p of parts.filter(Boolean)) lines.push({ ...JSON.parse(p), at: Date.now() });
    }
    return lines;
  }

  it('streams the output before the closing line', async () => {
    session();
    const res = await post({ id: ID, command: 'printf "a\\n"; sleep 0.4; printf "b\\n"' });
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    const lines = await readLines(res);
    const end = lines.at(-1);
    expect(lines.filter((l) => !l.done).map((l) => l.output).join('')).toBe('a\nb\n');
    expect(end.at - lines[0].at).toBeGreaterThanOrEqual(300);
    expect(end).toMatchObject({ done: true, ok: true, localCommand: { command: expect.any(String), code: 0 } });
  });

  it('reports a failing command as ran, with its exit code', async () => {
    session();
    const end = (await readLines(await post({ id: ID, command: 'exit 3' }))).at(-1);
    expect(end).toMatchObject({ done: true, ok: true, localCommand: { code: 3 } });
  });

  it('refuses a session hooked does not drive, before streaming anything', async () => {
    const res = await post({ id: 'nope', command: 'ls' });
    expect(res.status).toBe(409);
  });

  it('requires a command', async () => {
    session();
    expect((await post({ id: ID, command: '  ' })).status).toBe(400);
  });
});

describe('liveLogText', () => {
  it('leaves plain output untouched', () => {
    expect(liveLogText('line 1\nline 2\n')).toBe('line 1\nline 2\n');
  });

  it('treats CRLF as a plain line break', () => {
    expect(liveLogText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('keeps only the last repaint of a progress line', () => {
    expect(liveLogText('start\n 10%\r 50%\r100%\ndone\n')).toBe('start\n100%\ndone\n');
  });

  it('keeps a line whose carriage return has nothing after it yet', () => {
    // Tools that write `text\r` then repaint: a flush often ends right on the `\r`, and blanking the
    // line until the next chunk would make it flicker.
    expect(liveLogText('downloading 40%\r')).toBe('downloading 40%');
  });

  it('accepts an empty log', () => {
    expect(liveLogText('')).toBe('');
  });
});
