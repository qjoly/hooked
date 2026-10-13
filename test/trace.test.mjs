// trace.js: tool spans timed from tool_use to tool_result, grouped by real user turns.
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTrace, readToolDetail } from '../server/trace.js';

const ts = (s) => `2026-10-13T10:00:${String(s).padStart(2, '0')}.000Z`;
const tu = (id, name, input) => ({ type: 'tool_use', id, name, input });
const tr = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });

const lines = [
  { type: 'user', timestamp: ts(0), message: { content: 'first prompt' } },
  { type: 'assistant', timestamp: ts(2), message: { content: [tu('a', 'Bash', { command: 'ls' }), tu('b', 'Read', { file_path: '/x' })] } },
  { type: 'user', timestamp: ts(5), message: { content: [tr('a', 'out-a')] } },
  { type: 'user', timestamp: ts(3), isMeta: true, message: { content: 'skill body, not a turn' } },
  { type: 'user', timestamp: ts(6), message: { content: [tr('b', 'boom', true)] } },
  { type: 'assistant', timestamp: ts(8), isSidechain: true, message: { content: [tu('s', 'Grep', {})] } },
  { type: 'user', timestamp: ts(10), message: { content: 'no tools here' } },
  { type: 'assistant', timestamp: ts(11), message: { content: [{ type: 'text', text: 'ok' }] } },
  { type: 'user', timestamp: ts(20), message: { content: 'interrupted' } },
  { type: 'assistant', timestamp: ts(21), message: { content: [tu('c', 'mcp__gh__search', { query: 'q' })] } },
];

it('builds timed spans per turn and fetches one span detail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-trace-'));
  const fp = path.join(dir, 's.jsonl');
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'));
  const { turns } = buildTrace(fp);
  expect(turns.map((t) => t.prompt)).toEqual(['first prompt', 'interrupted']);
  const [a, b] = turns[0].spans;
  expect([a.name, a.detail, a.end - a.start, a.error]).toEqual(['Bash', 'ls', 3000, false]);
  expect([b.end - b.start, b.error]).toEqual([4000, true]);
  expect(turns[0].end - turns[0].start).toBe(6000);
  expect(turns[1].spans[0].end).toBeNull();
  expect(readToolDetail(fp, 'b')).toMatchObject({ input: '{\n  "file_path": "/x"\n}', result: 'boom', error: true });
  expect(readToolDetail(fp, 'nope')).toBeNull();
  fs.rmSync(dir, { recursive: true });
});
