/*
 * claude-code up-to-date feature (server/claudeUpdate.js + server/transcript.js).
 *   - parseSemver / cmpSemver : comparaison de versions x.y.z, tolérante au suffixe « (Claude Code) »
 *     et aux entrées non parsables (→ « égal », donc jamais faussement « outdated »).
 *   - parseTranscript capture bien la DERNIÈRE version stampée dans le transcript (= version que le
 *     process tourne). C'est le signal exact de détection des sessions à reconnecter.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parseSemver, cmpSemver } from '../server/claudeUpdate.js';
import { parseTranscript } from '../server/transcript.js';

describe('parseSemver', () => {
  it('parses a plain semver', () => { expect(parseSemver('2.1.185')).toEqual([2, 1, 185]); });
  it('tolerates the "(Claude Code)" suffix', () => { expect(parseSemver('2.1.185 (Claude Code)')).toEqual([2, 1, 185]); });
  it('returns null for junk', () => { expect(parseSemver('nope')).toBeNull(); });
});

describe('cmpSemver', () => {
  it('orders by major, minor, patch', () => {
    expect(cmpSemver('2.1.184', '2.1.185')).toBe(-1);
    expect(cmpSemver('2.1.185', '2.1.185')).toBe(0);
    expect(cmpSemver('2.2.0', '2.1.185')).toBe(1);
    expect(cmpSemver('3.0.0', '2.9.9')).toBe(1);
  });
  it('treats unparseable input as equal (never flags outdated)', () => {
    expect(cmpSemver(null, '2.1.185')).toBe(0);
    expect(cmpSemver('2.1.185', undefined)).toBe(0);
  });
});

describe('parseTranscript — version capture', () => {
  it('keeps the version of the LAST line that carries one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-ver-'));
    const fp = path.join(dir, 'sess-ver.jsonl');
    fs.writeFileSync(fp, [
      JSON.stringify({ type: 'user', sessionId: 'sess-ver', cwd: '/tmp/p', version: '2.1.180', timestamp: '2026-07-01T10:00:00.000Z', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', version: '2.1.185', timestamp: '2026-07-01T10:00:05.000Z', message: { id: 'm1', model: 'claude-opus-4-8', usage: {}, content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n');
    const s = parseTranscript(fp, 'sess-ver');
    expect(s.version).toBe('2.1.185');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves version null when no line carries one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-ver-'));
    const fp = path.join(dir, 'sess-nov.jsonl');
    fs.writeFileSync(fp, JSON.stringify({ type: 'user', sessionId: 'sess-nov', cwd: '/tmp/p', message: { role: 'user', content: 'hi' } }) + '\n');
    const s = parseTranscript(fp, 'sess-nov');
    expect(s.version).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
