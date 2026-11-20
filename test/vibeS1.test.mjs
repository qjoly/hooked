/*
 * S1 (PLAN_migration_mistral.md) : les routes/modules « id de session » passent par
 * scanAllSessions()/findSessionAny() au lieu de scanSessions() (Claude-only), et la corbeille
 * fonctionne pour les sessions vibe via meta.json archived_at.
 *
 * La fixture vibe est copiée dans un tmp dir (trash/restore modifient meta.json) ; la fixture
 * claude (test/fixtures/projects, pointée par HOOKED_PROJECTS_DIR dans vitest.config) sert de
 * contre-exemple provider claude (sess-alpha).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSessionAny, scanAllSessions, scanVibeSessions, vibeMessageText, trashSession, restoreSession, listTrashed, buildTrace } from '../server/index.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'vibe-session');
const PROJECTS = path.join(import.meta.dirname, 'fixtures', 'projects');
let TMP;
let VIBE; // copie tmp de la fixture vibe

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-s1-'));
  VIBE = path.join(TMP, 'vibe-sessions');
  fs.cpSync(FIX, VIBE, { recursive: true });
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('findSessionAny — résout un id quel que soit le provider', () => {
  it('trouve une session claude (fixture projects) et une session vibe (fixture unified)', () => {
    const claude = findSessionAny('sess-alpha', PROJECTS, VIBE);
    expect(claude).toBeTruthy();
    expect(claude.provider).toBeUndefined(); // provider claude = absence de champ (défaut)
    const vibe = findSessionAny('sess-abc123', PROJECTS, VIBE);
    expect(vibe).toBeTruthy();
    expect(vibe.provider).toBe('vibe');
    expect(vibe.dir).toBe(path.join(VIBE, 'sess-abc123'));
    expect(findSessionAny('nope', PROJECTS, VIBE)).toBeNull();
    expect(findSessionAny(null, PROJECTS, VIBE)).toBeNull();
  });
  it('scanAllSessions inclut les deux providers', () => {
    const all = scanAllSessions(PROJECTS, VIBE);
    expect(all.some((s) => s.id === 'sess-alpha')).toBe(true);
    expect(all.some((s) => s.id === 'sess-abc123' && s.provider === 'vibe')).toBe(true);
  });
});

describe('trash / restore d\'une session vibe (meta.json archived_at)', () => {
  it('archive → hors du scan, listée dans la corbeille, puis restore la remet', () => {
    const dir = path.join(VIBE, 'sess-abc123');
    // avant : visible
    expect(scanVibeSessions(VIBE).some((s) => s.id === 'sess-abc123')).toBe(true);
    expect(listTrashed(PROJECTS, VIBE).some((s) => s.id === 'sess-abc123')).toBe(false);

    const r1 = new Promise((res) => trashSession('sess-abc123', (e, r) => res({ e, r }), VIBE));
    return r1.then(({ e, r }) => {
      expect(e).toBeNull();
      expect(r.provider).toBe('vibe');
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      expect(meta.archived_at).toBeTruthy();
      // hors du scan principal, dans la corbeille
      expect(scanVibeSessions(VIBE).some((s) => s.id === 'sess-abc123')).toBe(false);
      const trashed = listTrashed(PROJECTS, VIBE).find((s) => s.id === 'sess-abc123');
      expect(trashed).toBeTruthy();
      expect(trashed.provider).toBe('vibe');
      expect(trashed.trashedAt).toBe(meta.archived_at);
      // re-trash → 404 (déjà à la corbeille)
      return new Promise((res) => trashSession('sess-abc123', (e2) => res(e2), VIBE)).then((e2) => {
        expect(e2 && e2.code).toBe(404);
        // restore
        return new Promise((res) => restoreSession('sess-abc123', (e3, r3) => res({ e3, r3 }), VIBE));
      }).then(({ e3, r3 }) => {
        expect(e3).toBeNull();
        expect(r3.provider).toBe('vibe');
        const meta2 = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        expect(meta2.archived_at).toBeNull();
        expect(scanVibeSessions(VIBE).some((s) => s.id === 'sess-abc123')).toBe(true);
        expect(listTrashed(PROJECTS, VIBE).some((s) => s.id === 'sess-abc123')).toBe(false);
      });
    });
  });
  it('trash refuse un id invalide (anti-traversal)', () => {
    return new Promise((res) => trashSession('../etc', (e) => res(e), VIBE)).then((e) => {
      expect(e && e.code).toBe(400);
    });
  });
});

describe('vibeMessageText — "show more" depuis le journal vibe', () => {
  it('retourne le texte complet de l\'entry par id (uuid = entry id)', () => {
    const dir = path.join(VIBE, 'sess-abc123');
    expect(vibeMessageText(dir, 'rs-1')).toBe('Premier prompt');
    expect(vibeMessageText(dir, 'rs-3')).toBe('Deuxième prompt');
    expect(vibeMessageText(dir, 'rs-999')).toBeNull();
    expect(vibeMessageText(dir, null)).toBeNull();
    // entry qui n'est pas un message (effect) → null
    expect(vibeMessageText(dir, 'effect-1')).toBeNull();
  });
});

describe('sanity — les builders Claude ne crashent pas sur un dossier journal vibe', () => {
  it('buildTrace(dir journal) retourne { turns: [] } sans throw', () => {
    expect(buildTrace(path.join(VIBE, 'sess-abc123', 'journal'))).toEqual({ turns: [] });
  });
});
