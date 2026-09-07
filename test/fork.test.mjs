/*
 * Tests du fork de session (server/fork.js + forkUuid de buildConversation).
 * Le lancement de session de forkSession() n'est pas testé ici (effet de bord système) ; on
 * couvre la logique pure de découpe/réécriture, qui en est le cœur.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildForkLines, danglingToolUses, buildConversation } from '../server/index.js';

const L = (o) => JSON.stringify(o);

// transcript synthétique : user → assistant(text+tool_use) → tool_result → assistant(text) → user
function sampleRaw() {
  return [
    L({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'orig', cwd: '/x', message: { content: 'salut' } }),
    L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'orig', message: { content: [{ type: 'text', text: 'je lance un outil' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    L({ type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId: 'orig', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    L({ type: 'assistant', uuid: 'a2', parentUuid: 'r1', sessionId: 'orig', message: { content: [{ type: 'text', text: 'voilà, terminé' }] } }),
    L({ type: 'user', uuid: 'u2', parentUuid: 'a2', sessionId: 'orig', message: { content: 'et ensuite ?' } }),
  ].join('\n') + '\n';
}

describe('buildForkLines', () => {
  it('coupe à une réponse assistant propre : préfixe complet, sessionId réécrit', () => {
    const r = buildForkLines(sampleRaw(), 'a2', 'NEW');
    expect(r.found).toBe(true);
    expect(r.lines.length).toBe(4); // u1, a1, r1, a2
    expect(r.lines.every((l) => JSON.parse(l).sessionId === 'NEW')).toBe(true);
    expect(JSON.parse(r.lines.at(-1)).uuid).toBe('a2');
    // le tool_use t1 garde son tool_result → préfixe équilibré
    expect(danglingToolUses(r.lines.map((l) => JSON.parse(l)))).toBe(0);
  });

  it('coupe à un prompt utilisateur : ne garde que jusqu\'à ce prompt', () => {
    const r = buildForkLines(sampleRaw(), 'u1', 'NEW');
    expect(r.found).toBe(true);
    expect(r.lines.length).toBe(1);
    expect(JSON.parse(r.lines[0]).uuid).toBe('u1');
    expect(JSON.parse(r.lines[0]).sessionId).toBe('NEW');
  });

  it('garde-fou : une coupe sur un tool_use sans résultat est rééquilibrée (lignes de fin retirées)', () => {
    // couper à a1 laisserait t1 sans tool_result (r1 est après) → on recule jusqu'à u1.
    const r = buildForkLines(sampleRaw(), 'a1', 'NEW');
    expect(r.found).toBe(true);
    expect(JSON.parse(r.lines.at(-1)).uuid).toBe('u1');
    expect(danglingToolUses(r.lines.map((l) => JSON.parse(l)))).toBe(0);
  });

  it('uuid introuvable : found=false, aucune ligne', () => {
    const r = buildForkLines(sampleRaw(), 'zzz', 'NEW');
    expect(r.found).toBe(false);
    expect(r.lines).toEqual([]);
  });

  it('ignore les lignes corrompues (non-JSON) sans casser la découpe', () => {
    const raw = 'pas du json\n' + sampleRaw();
    const r = buildForkLines(raw, 'a2', 'NEW');
    expect(r.found).toBe(true);
    expect(r.lines.length).toBe(4);
  });

  it('ne touche pas aux lignes sans sessionId', () => {
    const raw = L({ type: 'user', uuid: 'u1', message: { content: 'x' } }) + '\n';
    const r = buildForkLines(raw, 'u1', 'NEW');
    expect(JSON.parse(r.lines[0]).sessionId).toBeUndefined();
  });
});

describe('danglingToolUses', () => {
  it('compte les tool_use sans tool_result', () => {
    const objs = sampleRaw().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(danglingToolUses(objs)).toBe(0);          // tout est apparié
    expect(danglingToolUses(objs.slice(0, 2))).toBe(1); // u1 + a1(tool_use t1) sans r1
  });
});

describe('buildConversation — forkUuid (point de coupe par bulle)', () => {
  it('expose l\'uuid de la dernière ligne brute de chaque bulle', () => {
    const fp = path.join(os.tmpdir(), `hooked-fork-${process.pid}.jsonl`);
    fs.writeFileSync(fp, sampleRaw());
    try {
      const msgs = buildConversation(fp);
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(msgs[0].forkUuid).toBe('u1');
      // a1 et a2 fusionnent en une bulle assistant : le point de coupe est la DERNIÈRE ligne (a2)
      expect(msgs[1].forkUuid).toBe('a2');
      expect(msgs[2].forkUuid).toBe('u2');
    } finally {
      fs.unlinkSync(fp);
    }
  });
});

describe('buildConversation — dédup queue-operation ↔ tour user (collage multi-espaces/lignes)', () => {
  // Message mis en file (queue-operation, content brut) PUIS traité en tour user (passé par chatText,
  // qui collapse `[ \t]+`). Un collage de table alignée / multi-lignes doit être dédupliqué en UNE
  // seule bulle, sinon la table apparaît deux fois (bug « sent » + « ⏳ queued »).
  it('collapse le whitespace des deux côtés → une seule bulle user', () => {
    const pasted = 'NODE          NAMESPACE\n172.16.6.31   runtime\n172.16.6.21   runtime';
    const fp = path.join(os.tmpdir(), `hooked-dedup-${process.pid}.jsonl`);
    fs.writeFileSync(fp, [
      L({ type: 'queue-operation', operation: 'add', uuid: 'q1', timestamp: '2026-01-01T00:00:00Z', content: pasted }),
      L({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:01Z', message: { content: pasted } }),
    ].join('\n') + '\n');
    try {
      const msgs = buildConversation(fp);
      const users = msgs.filter((m) => m.role === 'user');
      expect(users.length).toBe(1);
    } finally {
      fs.unlinkSync(fp);
    }
  });
});
