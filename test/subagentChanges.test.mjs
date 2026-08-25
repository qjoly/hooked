/*
 * changes.js — fusion des modifications faites par les SOUS-AGENTS dans les changes de la session.
 * Les Edit/Write d'un sous-agent vivent dans <pdir>/<sessionId>/subagents/agent-*.jsonl : quand un
 * sessionId est fourni, buildFileChanges les scanne, tague chaque op `agent:<id>` et interleave
 * chronologiquement avec les ops du transcript principal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION = 'sess-1234';

let base, pdir, mainFp, fileA, fileB, changes;

function line(ts, name, input) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name, input }] } }) + '\n';
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-subagent-'));
  pdir = path.join(base, 'proj');
  const agentDir = path.join(pdir, SESSION, 'subagents');
  fs.mkdirSync(agentDir, { recursive: true });
  fileA = path.join(base, 'a.txt');
  fileB = path.join(base, 'b.txt');

  // main transcript: one Edit on A at 10:00
  mainFp = path.join(pdir, SESSION + '.jsonl');
  fs.writeFileSync(mainFp, line('2026-08-20T10:00:00.000Z', 'Edit', { file_path: fileA, old_string: 'one', new_string: 'two' }));
  // agent transcript: Write on B at 10:01, then Edit on A at 10:02 (interleaves after main's op)
  fs.writeFileSync(path.join(agentDir, 'agent-abc123.jsonl'),
    line('2026-08-20T10:01:00.000Z', 'Write', { file_path: fileB, content: 'from agent\n' })
    + line('2026-08-20T10:02:00.000Z', 'Edit', { file_path: fileA, old_string: 'two', new_string: 'three' }));
  // noise: a non-agent file in subagents/ must be ignored
  fs.writeFileSync(path.join(agentDir, 'notes.txt'), 'ignore me');

  process.env.HOOKED_DATA_DIR = path.join(base, 'data'); // no bash-changes here
  changes = await import('../server/changes.js');
});
afterAll(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} });

describe('buildFileChanges with subagents', () => {
  it('merges agent ops, tagged and chronologically interleaved', () => {
    const out = changes.buildFileChanges(mainFp, SESSION);
    expect(out.map((c) => path.basename(c.file)).sort()).toEqual(['a.txt', 'b.txt']);

    const a = out.find((c) => c.file === fileA);
    expect(a.rawOps.map((o) => [o.new, o.agent || null])).toEqual([['two', null], ['three', 'abc123']]);
    expect(a.count).toBe(2);
    expect(a.lastTs).toBe('2026-08-20T10:02:00.000Z');

    const b = out.find((c) => c.file === fileB);
    expect(b.tool).toBe('Write');
    expect(b.rawOps[0].agent).toBe('abc123');
    expect(b.rawOps[0].content).toBe('from agent\n');
  });

  it('buildFileChangeFull sees agent-touched files too', () => {
    const full = changes.buildFileChangeFull(mainFp, fileB, SESSION);
    expect(full).toBeTruthy();
    expect(full.rawOps[0].agent).toBe('abc123');
  });

  it('without a sessionId, only the given transcript is scanned', () => {
    const out = changes.buildFileChanges(mainFp);
    expect(out.map((c) => c.file)).toEqual([fileA]);
    expect(out[0].rawOps.length).toBe(1);
  });
});
