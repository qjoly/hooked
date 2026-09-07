/*
 * changes.js — un Write qui RÉÉCRIT un fichier existant doit produire un vrai diff, pas une
 * création. Le tool_use d'un Write ne porte que le nouveau contenu ; l'état écrasé est lu sur la
 * ligne de résultat (`toolUseResult.originalFile`) et attaché à l'op (`old`), ce qui rend aussi
 * reconstructible un Write suivi d'Edits (avant : bail dès qu'un write n'était pas en tête).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFileChanges } from '../server/changes.js';

const BEFORE = 'line one\nline two\nline three\n';
const AFTER = 'line one\nline TWO rewritten\nline three\n';

let dir;
function transcriptFor(name, lines) {
  const fp = path.join(dir, name + '.jsonl');
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return fp;
}
const writeUse = (id, file, content) => ({
  type: 'assistant', timestamp: '2026-09-07T10:00:00.000Z',
  message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content } }] },
});
const writeResult = (id, file, originalFile, content) => ({
  type: 'user', timestamp: '2026-09-07T10:00:01.000Z',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  toolUseResult: { type: originalFile ? 'update' : 'create', filePath: file, content, originalFile, structuredPatch: [] },
});

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-rewrite-')); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

describe('Write over an existing file', () => {
  it('reconstructs the overwritten content as the diff original', () => {
    const target = path.join(dir, 'rewritten.txt');
    fs.writeFileSync(target, AFTER); // disk = final state
    const fp = transcriptFor('rewrite', [
      writeUse('toolu_1', target, AFTER),
      writeResult('toolu_1', target, BEFORE, AFTER),
    ]);
    const c = buildFileChanges(fp).find((x) => x.file === target);
    expect(c.original).toBe(BEFORE);
    expect(c.ops).toEqual([{ kind: 'edit', old: BEFORE, new: AFTER, all: false, ts: '2026-09-07T10:00:00.000Z' }]);
    expect(c.rawOps[0].old).toBe(BEFORE); // le replay par prompt (lentille Ship) le voit aussi
  });

  it('reconstructs a rewrite followed by an edit (write no longer bails mid-history)', () => {
    const target = path.join(dir, 'rewritten-then-edited.txt');
    const final = AFTER.replace('three', 'THREE');
    fs.writeFileSync(target, final);
    const fp = transcriptFor('rewrite-edit', [
      writeUse('toolu_2', target, AFTER),
      writeResult('toolu_2', target, BEFORE, AFTER),
      {
        type: 'assistant', timestamp: '2026-09-07T10:01:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Edit', input: { file_path: target, old_string: 'three', new_string: 'THREE' } }] },
      },
    ]);
    const c = buildFileChanges(fp).find((x) => x.file === target);
    expect(c.original).toBe(BEFORE);
    expect(c.ops).toHaveLength(1); // un seul diff net, pas deux états intermédiaires
    expect(c.ops[0].new).toBe(final);
  });

  it('still reads as a creation when the file did not exist', () => {
    const target = path.join(dir, 'created.txt');
    fs.writeFileSync(target, AFTER);
    const fp = transcriptFor('create', [
      writeUse('toolu_4', target, AFTER),
      writeResult('toolu_4', target, '', AFTER),
    ]);
    const c = buildFileChanges(fp).find((x) => x.file === target);
    expect(c.original).toBe('');
    expect(c.rawOps[0]).toMatchObject({ kind: 'write', content: AFTER });
    expect(c.rawOps[0].old).toBeUndefined();
  });

  it('falls back to the old behaviour when the result line carries no original', () => {
    const target = path.join(dir, 'no-result.txt');
    fs.writeFileSync(target, AFTER);
    const fp = transcriptFor('no-result', [writeUse('toolu_5', target, AFTER)]);
    const c = buildFileChanges(fp).find((x) => x.file === target);
    expect(c.original).toBe('');
    expect(c.rawOps[0].old).toBeUndefined();
  });
});
