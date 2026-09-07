/*
 * changes.js — troncature bornée + chargement complet à la demande (lentille Ship).
 * buildFileChanges cape le contenu par défaut et marque `truncated:true` ; buildFileChangeFull
 * rend le même fichier SANS plafond. On vérifie qu'une grosse édition est bien capée puis
 * restituée entière.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFileChanges, buildFileChangeFull } from '../server/changes.js';

let dir, target, transcript;
const BIG = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'); // ~18 KB > EDIT_MAX

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-trunc-'));
  target = path.join(dir, 'big.txt');
  fs.writeFileSync(target, BIG); // disk = final state → the edit reconstructs cleanly
  transcript = path.join(dir, 'sess.jsonl');
  const line = JSON.stringify({
    type: 'assistant', timestamp: '2026-08-20T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: target, old_string: 'OLD', new_string: BIG } }] },
  });
  fs.writeFileSync(transcript, line + '\n');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

describe('capped buildFileChanges', () => {
  it('flags the large edit as truncated and caps its rawOps content', () => {
    const c = buildFileChanges(transcript).find((x) => x.file === target);
    expect(c).toBeTruthy();
    expect(c.truncated).toBe(true);
    expect(c.rawOps[0].new.length).toBe(12000); // EDIT_MAX
    expect(BIG.length).toBeGreaterThan(12000);
  });
});

describe('on-demand buildFileChangeFull', () => {
  it('returns the same file uncapped (full content, not truncated)', () => {
    const f = buildFileChangeFull(transcript, target);
    expect(f).toBeTruthy();
    expect(f.truncated).toBe(false);
    expect(f.rawOps[0].new.length).toBe(BIG.length);
    // reconstructs the net edit → its `new` is the full on-disk content
    expect(f.ops[0].new.length).toBe(BIG.length);
  });
  it('returns null for a file not touched in the transcript', () => {
    expect(buildFileChangeFull(transcript, path.join(dir, 'nope.txt'))).toBeNull();
  });
});
