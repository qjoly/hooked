/*
 * Provider pi (docs/port-pi.md) : scan + parse des sessions pi (fichiers .jsonl sous ~/.pi/agent/sessions),
 * conversation (shape identique au transcript Claude), corbeille (.trashed), contexte, trace.
 * La fixture est test/fixtures/pi-sessions/.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPiSessions, buildPiConversation, piSetArchived, piContext, buildPiTrace, piToolDetail, piToolPaths, findPiFile, activeBranch } from '../server/pi.js';

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
    const d = piToolDetail(f, 'call_1');
    expect(d.input).toEqual({ path: 'hello.txt', content: 'hi' });
    expect(d.result).toBe('Successfully wrote to hello.txt');
    expect(d.error).toBe(false);
    expect(piToolPaths(f)).toEqual([path.resolve('/tmp/projet-demo', 'hello.txt')]);
  });
});
