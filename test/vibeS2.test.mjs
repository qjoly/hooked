/*
 * S2 (PLAN_migration_mistral.md) : détail d'une session vibe — todos (vibe.todo), sous-agents
 * (effects kind=subagent), sous-sessions (child_sessions), screenshots (paths d'images des tools),
 * liens PR/issue, coût des sous-agents, jauge de contexte, forkUuid sur les messages.
 *
 * Fixtures : test/fixtures/vibe-s2/{sess-s2, sess-s2-child}. Le test screenshots crée en plus une
 * session tmp avec un vrai fichier image sur disque (vibeScreenshots ne garde que les fichiers
 * existants).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getVibeSession, latestVibeTodos, vibeSubagents, vibeSubSessions, vibeScreenshots,
  vibeToolPaths, vibeContext, buildVibeConversation, scanVibeSessions, readScreenshot, readUserFile,
} from '../server/index.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'vibe-s2');
const S2 = path.join(FIX, 'sess-s2');

describe('S2 — todos vibe (vibe.todo)', () => {
  it('dernier action:"write" fait foi, statuts normalisés comme Claude', () => {
    const t = latestVibeTodos(S2);
    expect(t).toBeTruthy();
    expect(t.todos).toHaveLength(4);
    expect(t.todos.map((x) => x.status)).toEqual(['completed', 'in_progress', 'pending', 'pending']); // cancelled → pending
    expect(t.todos[1].activeForm).toBe('Écriture du test');
    expect(t.todos[0].content).toBe('Lire le code');
  });
});

describe('S2 — sous-agents vibe (effects kind=subagent)', () => {
  it('shape identique à buildSubagents Claude, agentId = childSessionId pour le drill-in', () => {
    const subs = vibeSubagents(S2);
    expect(subs).toHaveLength(1);
    const s = subs[0];
    expect(s.id).toBe('effect-sub-1');
    expect(s.type).toBe('audit-x');
    expect(s.description).toBe('audit-x');
    expect(s.prompt).toContain('Auditer le module X');
    expect(s.result).toBe('Audit terminé : 3 findings.');
    expect(s.agentId).toBe('sess-s2-child');
    expect(s.running).toBe(false);
    expect(s.ts).toBeTruthy();
  });
});

describe('S2 — sous-sessions vibe', () => {
  it('child_sessions du meta + liens /session/<uuid> dans les messages', () => {
    const subs = vibeSubSessions(S2);
    expect(subs.some((x) => x.id === 'sess-s2-child' && x.source === 'child')).toBe(true);
  });
});

describe('S2 — résumé : liens PR/issue, coût sous-agents, exclusion du scan', () => {
  it('prLinks/issueLinks extraits du texte des messages, subagentCost replié depuis l\'enfant', () => {
    const s = getVibeSession(S2);
    expect(s.prLinks).toContain('https://github.com/qjoly/hooked/pull/131');
    expect(s.issueLinks).toContain('https://github.com/qjoly/hooked/issues/42');
    expect(s.subagentCost).toBeGreaterThan(0);
    expect(s.subagents).toBe(1);
    expect(s.provider).toBe('vibe');
    // l'enfant est déclaré dans child_sessions → exclu du listing principal (sous-agent)
    const all = scanVibeSessions(FIX);
    expect(all.map((x) => x.id)).toEqual(['sess-s2']);
  });
});

describe('S2 — forkUuid sur les messages de la conversation', () => {
  it('chaque bulle porte forkUuid = id de l\'entry (fork par bulle)', () => {
    const msgs = buildVibeConversation(S2);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs[0].forkUuid).toBe('rs-1');
    expect(msgs[1].forkUuid).toBe('rs-2');
  });
});

describe('S2 — jauge de contexte vibe', () => {
  it('vibeContext calcule { pct, size } depuis lastUsage + fenêtre du modèle', () => {
    const s = getVibeSession(S2);
    const ctx = vibeContext(s);
    expect(ctx).toBeTruthy();
    expect(ctx.size).toBeGreaterThan(0);
    expect(ctx.pct).toBeGreaterThanOrEqual(0);
    expect(ctx.pct).toBeLessThanOrEqual(100);
    // 2900 tokens / fenêtre du modèle → pct petit mais > 0 si fenêtre connue
    expect(ctx.pct).toBeGreaterThan(0);
    expect(vibeContext({ lastUsage: null })).toBeNull();
  });
});

describe('S2 — screenshots / user-file vibe (allowlist depuis le journal)', () => {
  let TMP, VIBE, img, txt;
  beforeAll(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-s2-shots-'));
    VIBE = path.join(TMP, 'unified');
    const dir = path.join(VIBE, 'sess-shot');
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    img = path.join(TMP, 'capture.png');
    txt = path.join(TMP, 'notes.txt');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])); // faux PNG
    fs.writeFileSync(txt, 'hello');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      session_id: 'sess-shot', parent_session_id: null, start_time: '2026-11-20T10:00:00Z',
      environment: { working_directory: TMP }, child_sessions: [], loops: [],
    }));
    const rec = (e) => ({ payload: { delta: [{ op: 'append_entry', entry: e }], watermark: 1 } });
    const lines = [
      rec({ type: 'effect', id: 'e1', sessionId: 'sess-shot', createdAt: 1, updatedAt: 1,
            detail: { kind: 'tool', toolName: 'file_system.read_file', input: { path: img } },
            state: { status: 'completed' } }),
      rec({ type: 'effect', id: 'e2', sessionId: 'sess-shot', createdAt: 2, updatedAt: 2,
            detail: { kind: 'tool', toolName: 'file_system.read_file', input: { path: txt } },
            state: { status: 'completed' } }),
    ];
    fs.writeFileSync(path.join(dir, 'journal', '0000000000000001.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('vibeScreenshots ne garde que les chemins image existants ; vibeToolPaths couvre tous les fichiers', () => {
    const shots = vibeScreenshots(path.join(VIBE, 'sess-shot'));
    expect(shots).toHaveLength(1);
    expect(shots[0].path).toBe(img);
    expect(shots[0].name).toBe('capture.png');
    expect(shots[0].size).toBe(8);
    const paths = [...vibeToolPaths(path.join(VIBE, 'sess-shot')).keys()];
    expect(paths).toContain(img);
    expect(paths).toContain(txt);
  });

  it('readScreenshot sert une image allowlistée (session vibe) et refuse le reste', () => {
    const ok = readScreenshot('sess-shot', img, undefined, VIBE);
    expect(ok).toBeTruthy();
    expect(ok.contentType).toBe('image/png');
    expect(ok.buffer.length).toBe(8);
    expect(readScreenshot('sess-shot', txt, undefined, VIBE)).toBeNull(); // pas une image
    expect(readScreenshot('sess-shot', '/etc/hostname', undefined, VIBE)).toBeNull(); // hors allowlist
  });

  it('readUserFile sert un fichier allowlisté (session vibe) et refuse un chemin arbitraire', () => {
    const ok = readUserFile('sess-shot', null, txt, undefined, VIBE);
    expect(ok).toBeTruthy();
    expect(ok.buffer.toString()).toBe('hello');
    expect(readUserFile('sess-shot', null, '/etc/hosts', undefined, VIBE)).toBeNull();
  });
});
