/*
 * Provider pi (docs/port-pi.md) : scan + parse des sessions pi (fichiers .jsonl sous ~/.pi/agent/sessions),
 * conversation (shape identique au transcript Claude), corbeille (.trashed), contexte, trace.
 * La fixture est test/fixtures/pi-sessions/.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPiSessions, buildPiConversation, piSetArchived, piContext, buildPiTrace, piToolDetail, piToolPaths, findPiFile, activeBranch, scanPiOps } from '../server/pi.js';
import { buildPiUsage } from '../server/stats.js';
import { buildFileChanges, buildFileChangeFull } from '../server/changes.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'pi-sessions');
let tmp;

function cloneFx() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));
  fs.cpSync(FX, path.join(tmp, 'sessions'), { recursive: true });
  return path.join(tmp, 'sessions');
}

describe('scanPiSessions', () => {
  it('scanne la fixture : summary complet + provider pi', () => {
    const dir = cloneFx();
    const list = scanPiSessions(dir);
    expect(list.length).toBe(1);
    const s = list[0];
    expect(s.provider).toBe('pi');
    expect(s.id).toBe('sess-pi-1');
    expect(s.project).toBe('/tmp/projet-demo');
    expect(s.projectName).toBe('projet-demo');
    expect(s.model).toBe('mistral-medium-3.5');
    expect(s.title).toBe('démo pi'); // session_info prioritaire sur le premier prompt
    expect(s.firstPrompt).toContain('hello.txt');
    expect(s.lastReply).toBe('DONE');
    expect(s.userPrompts).toBe(1);
    expect(s.assistantTurns).toBe(2);
    expect(s.tools).toEqual({ write: 1 });
    expect(s.usage.input).toBe(840);
    expect(s.usage.cacheRead).toBe(1800);
    expect(s.cost).toBeCloseTo(0.0017175, 9);
    expect(s.lastUsage.contextTokens).toBe(1345);
    expect(s.prLinks).toEqual(['https://github.com/qjoly/hooked/pull/131']);
    expect(s.startTs).toBe('2026-11-21T09:00:00.000Z');
    expect(s.lastTs).toBe('2026-11-21T09:05:00.000Z');
  });

  it('ignore les fichiers .trashed', () => {
    const dir = cloneFx();
    const f = findPiFile(dir, 'sess-pi-1');
    expect(piSetArchived(f, true)).toBe(true);
    expect(scanPiSessions(dir).length).toBe(0);
    expect(piSetArchived(f + '.trashed', false)).toBe(true);
    expect(scanPiSessions(dir).length).toBe(1);
  });
});

describe('buildPiConversation', () => {
  it('reconstruit user/assistant avec tools appariés (toolCall ↔ toolResult) et diff write', () => {
    const dir = cloneFx();
    const f = findPiFile(dir, 'sess-pi-1');
    const msgs = buildPiConversation(f);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    const [u, a1, a2] = msgs;
    expect(u.text).toContain('hello.txt');
    expect(u.forkUuid).toBe('e10');
    expect(a1.thinking).toBe('je dois écrire le fichier');
    // thinking is an ordered part, rendered in the bubble before the tool call it led to
    expect(a1.parts.map((p) => p.type)).toEqual(['thinking', 'tool']);
    expect(a1.parts[0].text).toBe('je dois écrire le fichier');
    expect(a1.tools.length).toBe(1);
    const w = a1.tools[0];
    expect(w.name).toBe('write');
    expect(w.id).toBe('call_1');
    expect(w.input).toEqual({ path: 'hello.txt', content: 'hi' });
    expect(w.status).toBe('done');          // résolu par le toolResult e12
    expect(w.result).toBe('Successfully wrote to hello.txt');
    expect(w.diff).toMatchObject({ file: 'hello.txt', ops: [{ kind: 'write', content: 'hi' }] });
    expect(a2.text).toBe('DONE');
    expect(a2.usage.totalTokens).toBe(1345);
  });
});

describe('activeBranch', () => {
  it('ne garde que la branche du leaf', () => {
    const entries = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'd', parentId: 'b' },   // branche abandonnée (écrite avant)
      { id: 'c', parentId: 'b' },   // branche active : la dernière ligne est le leaf
    ];
    const branch = activeBranch(entries);
    expect(branch.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('accessoires', () => {
  it('piContext calcule le % depuis le dernier usage + fenêtre du modèle', () => {
    const dir = cloneFx();
    const s = scanPiSessions(dir)[0];
    const ctx = piContext(s);
    expect(ctx.size).toBe(1345);
    expect(ctx.contextWindow).toBe(262144); // medium
    expect(ctx.pct).toBeCloseTo((1345 / 262144) * 100, 5);
  });

  it('buildPiTrace + piToolDetail + piToolPaths', () => {
    const dir = cloneFx();
    const f = findPiFile(dir, 'sess-pi-1');
    const trace = buildPiTrace(f);
    expect(trace.turns.length).toBe(1);
    expect(trace.turns[0].spans.length).toBe(1);
    expect(trace.turns[0].spans[0].name).toBe('write');
    // timestamps en epoch ms (number), comme buildTrace côté Claude : le desktop fait de
    // l'arithmétique f64 dessus (serde attend f64, une ISO string lève "invalid type")
    expect(trace.turns[0].start).toBe(1763694001000);
    expect(trace.turns[0].spans[0].start).toBe(1763694002000);
    expect(trace.turns[0].spans[0].end).toBe(1763694003000);
    const d = piToolDetail(f, 'call_1');
    expect(JSON.parse(d.input)).toEqual({ path: 'hello.txt', content: 'hi' });
    expect(d.result).toBe('Successfully wrote to hello.txt');
    expect(d.error).toBe(false);
    expect(piToolPaths(f)).toEqual([path.resolve('/tmp/projet-demo', 'hello.txt')]);
  });
});

describe('buildPiUsage (usage pi de l\'entête / TopBar)', () => {
  it('renvoie la session la plus fraîche avec sa jauge de contexte, son modèle et son coût', () => {
    const dir = cloneFx();
    const u = buildPiUsage(scanPiSessions(dir), {});
    expect(u.sessionId).toBe('sess-pi-1');
    expect(u.title).toBe('démo pi');
    expect(u.model).toBe('mistral-medium-3.5');
    expect(u.live).toBe(false);
    expect(u.at).toBe('2026-11-21T09:05:00.000Z');
    expect(u.context.size).toBe(1345);
    expect(u.context.contextWindow).toBe(262144); // medium
    expect(u.context.pct).toBeCloseTo((1345 / 262144) * 100, 1);
    expect(u.cost).toBeCloseTo(0.0017175, 9);
    expect(u.sessions).toBe(1);
    expect(u.todayCost).toBe(0); // la fixture est datée de 2026-11-21, pas d'aujourd'hui
    expect(u.todayTokens).toBe(0);
  });

  it('agrège l\'usage du jour sur toutes les sessions pi (byDay)', () => {
    const dir = cloneFx();
    const [s] = scanPiSessions(dir);
    const today = new Date().toISOString().slice(0, 10);
    const withToday = {
      ...s,
      id: 'sess-today',
      lastTs: new Date().toISOString(),
      cost: 2.5,
      byDay: { [today]: { input: 1000, output: 500, cacheRead: 100, cacheCreate: 50, cost: 1.25, turns: 1 } },
    };
    const u = buildPiUsage([s, withToday], {});
    expect(u.sessions).toBe(2);
    expect(u.todayCost).toBeCloseTo(1.25, 9);
    expect(u.todayTokens).toBe(1650);
    expect(u.cost).toBeCloseTo(0.0017175 + 2.5, 9);
    expect(u.sessionId).toBe('sess-today'); // la plus fraîche gagne pour le tooltip
  });

  it('null sans session pi, et une session archivée (meta) est ignorée', () => {
    expect(buildPiUsage([], {})).toBe(null);
    expect(buildPiUsage([{ provider: 'claude', id: 'x' }], {})).toBe(null);
    const dir = cloneFx();
    expect(buildPiUsage(scanPiSessions(dir), { 'sess-pi-1': { archived: true } })).toBe(null);
  });

  it('préfère la session la plus récente quand il y en a plusieurs', () => {
    const dir = cloneFx();
    const [s] = scanPiSessions(dir);
    const older = { ...s, id: 'sess-old', lastTs: '2026-11-20T09:00:00.000Z' };
    const newer = { ...s, id: 'sess-new', lastTs: '2026-11-22T09:00:00.000Z' };
    expect(buildPiUsage([older, newer], {}).sessionId).toBe('sess-new');
    expect(buildPiUsage([newer, older], {}).sessionId).toBe('sess-new');
  });
});

describe('scanPiOps / buildFileChanges (scope « session » de la lens Review)', () => {
  it('scanne la fixture : write résolu contre le cwd, ts ISO', () => {
    const dir = cloneFx();
    const f = findPiFile(dir, 'sess-pi-1');
    const byFile = scanPiOps(f);
    expect([...byFile.keys()]).toEqual(['/tmp/projet-demo/hello.txt']);
    const e = byFile.get('/tmp/projet-demo/hello.txt');
    expect(e.tool).toBe('write');
    expect(e.count).toBe(1);
    expect(e.lastTs).toBe('2025-11-21T03:00:02.000Z'); // m.timestamp (epoch ms) prioritaire sur e.timestamp
    expect(e.ops).toEqual([{ kind: 'write', content: 'hi', ts: '2025-11-21T03:00:02.000Z' }]);
  });

  it('buildFileChanges sur journal pi : fichier absent du disque → ops brutes', () => {
    const dir = cloneFx();
    const f = findPiFile(dir, 'sess-pi-1');
    const changes = buildFileChanges(f);
    expect(changes.length).toBe(1);
    expect(changes[0].file).toBe('/tmp/projet-demo/hello.txt');
    expect(changes[0].name).toBe('hello.txt');
    expect(changes[0].count).toBe(1);
    expect(changes[0].ops[0]).toMatchObject({ kind: 'write', content: 'hi' });
    expect(changes[0].rawOps[0].ts).toBe('2025-11-21T03:00:02.000Z');
  });

  it('rejoue les edits à rebours quand le fichier existe (net original → final), edit legacy comprise', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
    fs.writeFileSync(path.join(proj, 'a.txt'), 'final content\n');
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
    const f = path.join(sessDir, '2026-11-21T10-00-00-000Z_sess-x.jsonl');
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'session', version: 3, id: 'sess-x', timestamp: '2026-11-21T10:00:00.000Z', cwd: proj }),
      JSON.stringify({ type: 'message', id: 'e1', parentId: null, timestamp: '2026-11-21T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'modifie a.txt' }], timestamp: 1763697601000 } }),
      JSON.stringify({ type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-11-21T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: 'a.txt', edits: [{ oldText: 'orig', newText: 'final content\n' }] } }], timestamp: 1763697602000 } }),
      // forme legacy : un seul oldText/newText à la racine des arguments
      JSON.stringify({ type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-11-21T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: 'a.txt', oldText: 'x', newText: 'y' } }], timestamp: 1763697603000 } }),
    ].join('\n') + '\n');
    const changes = buildFileChanges(f);
    expect(changes.length).toBe(1);
    expect(changes[0].file).toBe(path.join(proj, 'a.txt'));
    expect(changes[0].count).toBe(2);
    // reconstruction : le disque est l'état final, l'edit c1 s'inverse → original connu
    expect(changes[0].original).toBe('orig');
    expect(changes[0].ops).toEqual([{ kind: 'edit', old: 'orig', new: 'final content\n', all: false, ts: changes[0].lastTs }]);
    // buildFileChangeFull retrouve la même entrée sans plafond
    const full = buildFileChangeFull(f, path.join(proj, 'a.txt'));
    expect(full.original).toBe('orig');
    expect(full.truncated).toBe(false);
  });

  it('un transcript Claude n\'est pas pris pour un journal pi', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sess-'));
    const f = path.join(dir, 'sess-claude.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'system', subtype: 'init', sessionId: 'sess-claude', cwd: dir }) + '\n');
    expect(scanPiOps(f).size).toBe(0); // piRead sans header → map vide
    expect(buildFileChanges(f)).toEqual([]);
  });
});
