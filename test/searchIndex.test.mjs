/*
 * Tests pour l'index plein-texte (server/searchIndex.js).
 * - Construit l'index sur les fixtures (HOOKED_PROJECTS_DIR pointé via vitest.config).
 * - Vérifie : indexation initiale, ré-index incrémental sur mtime, snippet, filtre projet,
 *   GC d'une session supprimée.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { refresh, search, close } from '../server/searchIndex.js';

// DB temporaire par test : on isole l'état (le module garde un singleton).
let tmpDb;
beforeEach(() => {
  tmpDb = path.join(os.tmpdir(), `hooked-search-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.HOOKED_SEARCH_DB = tmpDb;
});
afterEach(() => {
  close();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  delete process.env.HOOKED_SEARCH_DB;
});

describe('searchIndex', () => {
  it('indexe les fixtures à la première recherche', () => {
    const stats = refresh();
    expect(stats.indexed).toBeGreaterThan(0);
    // 2è refresh : tout en cache, rien à ré-indexer
    const again = refresh();
    expect(again.indexed).toBe(0);
    expect(again.skipped).toBe(stats.indexed);
  });

  it('trouve le prompt user "refactor"', () => {
    const r = search('refactor');
    expect(r.length).toBeGreaterThan(0);
    const hit = r.find((x) => x.sessionId === 'sess-alpha' && x.role === 'user');
    expect(hit).toBeTruthy();
    expect(hit.snippet).toMatch(/<mark>refactor<\/mark>/i);
  });

  it('trouve aussi la prose assistant', () => {
    const r = search('tests');
    const assistantHit = r.find((x) => x.role === 'assistant');
    expect(assistantHit).toBeTruthy();
  });

  it('filtre par projet', () => {
    const all = search('login');
    const betaOnly = search('login', { project: '/Users/test/proj-beta' });
    expect(betaOnly.length).toBeGreaterThan(0);
    expect(betaOnly.every((r) => r.project === '/Users/test/proj-beta')).toBe(true);
    expect(betaOnly.length).toBeLessThanOrEqual(all.length);
  });

  it('renvoie [] sur requête vide', () => {
    expect(search('')).toEqual([]);
    expect(search('   ')).toEqual([]);
  });

  it('ré-indexe quand le mtime change', () => {
    // copie une session dans un dir temporaire pour pouvoir la muter sans casser les autres tests
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-proj-'));
    const projDir = path.join(tmpProj, '-Users-test-proj-temp');
    fs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, 'sess-temp.jsonl');
    fs.writeFileSync(file,
      JSON.stringify({ type: 'user', isSidechain: false, sessionId: 'sess-temp', cwd: '/Users/test/proj-temp', timestamp: '2026-06-10T10:00:00.000Z', message: { role: 'user', content: 'zebra alpha bravo' } }) + '\n'
    );
    // search() déclenche un refresh() interne sur PROJECTS_DIR (figé à l'import) ; on
    // passe `projectsDir` pour pointer le scan sur tmpProj sans casser PROJECTS_DIR global.
    try {
      const before = refresh(tmpProj);
      expect(before.indexed).toBe(1);
      expect(search('zebra', { projectsDir: tmpProj }).some((r) => r.sessionId === 'sess-temp')).toBe(true);
      expect(search('charlie', { projectsDir: tmpProj }).some((r) => r.sessionId === 'sess-temp')).toBe(false);

      // mute le fichier + force un mtime postérieur (touch +2s)
      fs.appendFileSync(file,
        JSON.stringify({ type: 'user', isSidechain: false, sessionId: 'sess-temp', cwd: '/Users/test/proj-temp', timestamp: '2026-06-10T11:00:00.000Z', message: { role: 'user', content: 'charlie delta' } }) + '\n'
      );
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(file, future, future);

      const after = refresh(tmpProj);
      expect(after.indexed).toBe(1);
      expect(search('charlie', { projectsDir: tmpProj }).some((r) => r.sessionId === 'sess-temp')).toBe(true);
      expect(search('zebra', { projectsDir: tmpProj }).some((r) => r.sessionId === 'sess-temp')).toBe(true);
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it('purge les sessions disparues du FS', () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-proj-'));
    const projDir = path.join(tmpProj, '-Users-test-proj-gc');
    fs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, 'sess-gc.jsonl');
    fs.writeFileSync(file,
      JSON.stringify({ type: 'user', isSidechain: false, sessionId: 'sess-gc', cwd: '/Users/test/proj-gc', timestamp: '2026-06-10T10:00:00.000Z', message: { role: 'user', content: 'pamplemousse unique' } }) + '\n'
    );
    try {
      refresh(tmpProj);
      expect(search('pamplemousse', { projectsDir: tmpProj }).length).toBeGreaterThan(0);

      fs.unlinkSync(file);
      const stats = refresh(tmpProj);
      expect(stats.removed).toBe(1);
      expect(search('pamplemousse', { projectsDir: tmpProj }).length).toBe(0);
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});
