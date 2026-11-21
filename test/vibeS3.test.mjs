/*
 * S3 (PLAN_migration_mistral.md) : trace lens vibe (buildVibeTrace / vibeToolDetail depuis les
 * effects du journal) + index FTS des sessions vibe (searchIndex sur scanAllSessions, clé = dir).
 *
 * Fixture : test/fixtures/vibe-s2/sess-s2 (1 user avec lien PR, effects vibe.todo + read_file +
 * subagent, 1 assistant). La DB FTS est isolée par test via HOOKED_SEARCH_DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVibeTrace, vibeToolDetail } from '../server/vibe.js';
import { refresh, search, close } from '../server/searchIndex.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'vibe-s2');
const PROJECTS = path.join(import.meta.dirname, 'fixtures', 'projects');
const S2 = path.join(FIX, 'sess-s2');

describe('S3 — buildVibeTrace (même shape que buildTrace Claude)', () => {
  it('un span par effect tool, groupé par tour user ; subagent exclu des spans tool', () => {
    const trace = buildVibeTrace(S2);
    expect(trace.turns).toHaveLength(1);
    const turn = trace.turns[0];
    expect(turn.prompt).toContain('github.com/qjoly/hooked/pull/131');
    // 2 spans tool (vibe.todo + read_file) — l'effect subagent n'est pas un span tool
    expect(turn.spans).toHaveLength(2);
    const names = turn.spans.map((s) => s.name);
    expect(names).toContain('todo');
    expect(names).toContain('read_file');
    const read = turn.spans.find((s) => s.name === 'read_file');
    expect(read.id).toBe('tc-read');
    expect(read.detail).toBe('/tmp/proj-vibe/shot.png');
    expect(read.start).toBeGreaterThan(0);
    expect(read.end).toBeGreaterThanOrEqual(read.start); // completed → end renseigné
    expect(read.error).toBe(false);
  });
});

describe('S3 — vibeToolDetail', () => {
  it('retourne { input, result, error } depuis state.output (pas outputText)', () => {
    const d = vibeToolDetail(S2, 'tc-read');
    expect(d).toBeTruthy();
    expect(d.input).toContain('shot.png');
    expect(d.error).toBe(false);
    // read_file de la fixture : structured_content {path} → fallback JSON lisible
    expect(d.result).toContain('shot.png');
    expect(vibeToolDetail(S2, 'inconnu')).toBeNull();
    expect(vibeToolDetail(S2, null)).toBeNull();
  });
});

describe('S3 — searchIndex indexe aussi les sessions vibe', () => {
  let tmpDb;
  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `hooked-search-s3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.HOOKED_SEARCH_DB = tmpDb;
  });
  afterEach(() => {
    close();
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    delete process.env.HOOKED_SEARCH_DB;
  });

  it('refresh indexe claude + vibe ; search retrouve un prompt d\'une session vibe', () => {
    const stats = refresh(PROJECTS, FIX);
    expect(stats.indexed).toBeGreaterThanOrEqual(2); // au moins 1 claude + 1 vibe
    const r = search('pull/131', { projectsDir: PROJECTS, vibeSessionsDir: FIX });
    const hit = r.find((x) => x.sessionId === 'sess-s2' && x.role === 'user');
    expect(hit).toBeTruthy();
    expect(hit.role).toBe('user');
    expect(hit.snippet).toContain('<mark>');
    // la session claude reste indexée (non-régression)
    const r2 = search('refactor', { projectsDir: PROJECTS, vibeSessionsDir: FIX });
    expect(r2.some((x) => x.sessionId === 'sess-alpha')).toBe(true);
  });

  it('ré-index incrémental vibe : un 2è refresh ne ré-indexe rien, un journal qui grossit est repris', () => {
    refresh(PROJECTS, FIX);
    const again = refresh(PROJECTS, FIX);
    expect(again.indexed).toBe(0);
    // append un message à la fixture copiée dans un tmp (ne pas toucher la fixture du repo)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-s3-'));
    fs.cpSync(FIX, tmp, { recursive: true });
    const jf = path.join(tmp, 'sess-s2', 'journal', '0000000000000001.jsonl');
    const backup = fs.readFileSync(jf, 'utf8');
    try {
      fs.appendFileSync(jf, JSON.stringify({ payload: { delta: [{ op: 'append_entry', entry: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'MotUniqueS3 pour la recherche incrémentale' }], createdAt: 1795200099000, updatedAt: 1795200099000, id: 'rs-99', sessionId: 'sess-s2', turnId: 'turn-1' } }], watermark: 9 } }) + '\n');
      // mtime a changé → ré-indexé
      const r3 = refresh(PROJECTS, tmp);
      expect(r3.indexed).toBe(1);
      const hits = search('MotUniqueS3', { projectsDir: PROJECTS, vibeSessionsDir: tmp });
      expect(hits.some((x) => x.sessionId === 'sess-s2' && x.role === 'assistant')).toBe(true);
    } finally {
      fs.writeFileSync(jf, backup);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
