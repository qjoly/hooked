/*
 * S6 (PLAN_migration_mistral.md) : parité desktop-rune / web côté serveur — le diff inline des
 * tools fichiers vibe (file_system.write_file / edit_file / multi_edit) est construit avec
 * toolDiffOps (mêmes ops que Claude Write/Edit/MultiEdit), pour que ToolChip (web) et
 * tool_chip (rune) rendent le diff sans changement de leur côté.
 *
 * La session est créée en tmp (journal CRDT minimal, même format que les fixtures vibe-s2).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVibeConversation } from '../server/index.js';

let dir;
let tmp;

function entry(e) {
  return JSON.stringify({ payload: { delta: [{ op: 'append_entry', entry: e }], watermark: 1 } });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-s6-'));
  dir = path.join(tmp, 'sess-s6');
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    session_id: 'sess-s6',
    start_time: '2026-11-20T10:00:00.000000+00:00',
    environment: { working_directory: '/tmp/proj' },
    origin_directory: '/tmp/proj',
  }));
  const lines = [
    entry({ type: 'message', role: 'user', content: [{ type: 'text', text: 'modifie le fichier' }], createdAt: 1, updatedAt: 1, id: 'm-1', sessionId: 'sess-s6', turnId: 't-1' }),
    entry({ type: 'effect', id: 'e-w', sessionId: 'sess-s6', turnId: 't-1', createdAt: 2, updatedAt: 3, toolCallId: 'tc-w', title: 'file_system.write_file', detail: { kind: 'tool', toolName: 'file_system.write_file', input: { path: '/tmp/proj/a.txt', content: 'hello\nworld\n' } }, state: { status: 'completed', output: { content: [{ type: 'text', text: 'ok' }] } } }),
    entry({ type: 'effect', id: 'e-e', sessionId: 'sess-s6', turnId: 't-1', createdAt: 4, updatedAt: 5, toolCallId: 'tc-e', title: 'file_system.edit_file', detail: { kind: 'tool', toolName: 'file_system.edit_file', input: { path: '/tmp/proj/a.txt', old_string: 'world', new_string: 'vibe' } }, state: { status: 'completed', output: { content: [{ type: 'text', text: 'ok' }] } } }),
    entry({ type: 'effect', id: 'e-b', sessionId: 'sess-s6', turnId: 't-1', createdAt: 6, updatedAt: 7, toolCallId: 'tc-b', title: 'bash', detail: { kind: 'tool', toolName: 'bash', input: { command: 'ls' } }, state: { status: 'completed', output: { content: [{ type: 'text', text: 'a.txt' }] } } }),
    entry({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'voilà' }], createdAt: 8, updatedAt: 8, id: 'm-2', sessionId: 'sess-s6', turnId: 't-1' }),
  ];
  fs.writeFileSync(path.join(dir, 'journal', '0000000000000001.jsonl'), lines.join('\n') + '\n');
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('S6 — diff inline des tools fichiers vibe', () => {
  const tools = () => buildVibeConversation(dir).find((m) => m.role === 'assistant').tools;

  it('write_file produit un diff { file, ops:[{kind:"write", content}] }', () => {
    const w = tools().find((t) => t.name === 'write_file');
    expect(w).toBeTruthy();
    expect(w.diff).toBeTruthy();
    expect(w.diff.file).toBe('/tmp/proj/a.txt');
    expect(w.diff.ops[0].kind).toBe('write');
    expect(w.diff.ops[0].content).toBe('hello\nworld\n');
  });

  it('edit_file produit un diff { kind:"edit", old, new }', () => {
    const e = tools().find((t) => t.name === 'edit_file');
    expect(e.diff).toBeTruthy();
    expect(e.diff.ops[0]).toMatchObject({ kind: 'edit', old: 'world', new: 'vibe' });
  });

  it('un tool non-fichier (bash) n’a pas de diff', () => {
    const b = tools().find((t) => t.name === 'bash');
    expect(b).toBeTruthy();
    expect(b.diff).toBeUndefined();
    expect(b.inputText).toContain('ls'); // le détail d’appel reste dépliable
  });
});
