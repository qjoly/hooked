/*
 * Hiding remote-control daemon sessions from the dashboard (server/events.js).
 *
 * These daemons are infrastructure, not sessions you drive, so buildSessions filters them out. They
 * used to be recognized by the tmux session name their pane lived in (`hooked-rc-*`), with a
 * separate rc-sessions.json to keep them hidden once the pane died. Off tmux there is no name to
 * match, so hooked instead sets HOOKED_RC=1 in the daemon's environment and hook.cjs copies it onto
 * every event as `rc: true` — which also removes the need for the extra persistence file, since
 * events.jsonl already outlives the daemon.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-rchidden-test-' + process.pid);
const FILE = path.join(TMP, 'events.jsonl');

let ev;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const lines = [
    { ts: '2026-01-01T00:00:00Z', event: 'SessionStart', session_id: 'normal' },
    { ts: '2026-01-01T00:00:01Z', event: 'SessionStart', session_id: 'daemon', rc: true },
    // le drapeau n'a pas besoin d'être sur TOUS les évènements de la session : un seul suffit à la
    // classer, et il tient après la mort du démon (events.jsonl reste sur disque).
    { ts: '2026-01-01T00:00:02Z', event: 'Stop', session_id: 'daemon' },
    { ts: '2026-01-01T00:00:03Z', event: 'Stop', session_id: null, rc: true }, // sans id → ignoré
  ];
  fs.writeFileSync(FILE, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  ev = await import('../server/events.js');
});

describe('rcSessionIdsFromEvents', () => {
  it('collects only the session ids flagged rc', () => {
    const set = ev.rcSessionIdsFromEvents(FILE);
    expect([...set]).toEqual(['daemon']);
    expect(set.has('normal')).toBe(false);
  });

  it('returns an empty set when there is no events file', () => {
    expect([...ev.rcSessionIdsFromEvents(path.join(TMP, 'nope.jsonl'))]).toEqual([]);
  });
});
