/*
 * buildSubSessions — sessions sœurs créées / référencées par une conversation.
 * Fixture minimale écrite dans un tmpdir : on couvre les deux sources (created / referenced),
 * la dédup, l'exclusion de la session courante et l'ordre de première apparition.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSubSessions } from '../server/subSessions.js';

// écrit un transcript .jsonl (une ligne JSON par entrée) et renvoie son chemin.
const mk = (name, lines) => {
  const fp = path.join(os.tmpdir(), `hooked-subsess-${name}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return fp;
};

// tool_use start_session + son tool_result apparié (par tool_use_id) contenant le link.
const startSession = (id, link) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__hooked__start_session', input: { cwd: '/x' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ tmux: 'hooked-x', link }) }] } },
];

describe('buildSubSessions', () => {
  it('détecte une session CRÉÉE (start_session → link dans le tool_result)', () => {
    const fp = mk('created', startSession('tu1', '/session/child-1'));
    expect(buildSubSessions(fp, 'self')).toEqual([{ id: 'child-1', label: '', source: 'created' }]);
  });

  it('détecte une session RÉFÉRENCÉE (lien markdown dans le texte assistant)', () => {
    const fp = mk('ref', [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Voir [le worker](/session/child-2) pour la suite.' }] } },
    ]);
    expect(buildSubSessions(fp, 'self')).toEqual([{ id: 'child-2', label: 'le worker', source: 'referenced' }]);
  });

  it('détecte aussi un lien dans un message utilisateur (string content)', () => {
    const fp = mk('userref', [
      { type: 'user', message: { content: 'regarde [ça](/session/child-3)' } },
    ]);
    expect(buildSubSessions(fp, 'self')).toEqual([{ id: 'child-3', label: 'ça', source: 'referenced' }]);
  });

  it('union dédupliquée par id, ordre de première apparition (created avant sa référence)', () => {
    const fp = mk('union', [
      ...startSession('tu1', '/session/a'),
      { type: 'assistant', message: { content: [{ type: 'text', text: '[a de nouveau](/session/a) et [b](/session/b)' }] } },
    ]);
    // `a` vue d'abord via created → garde source:created ; `b` référencée ensuite.
    expect(buildSubSessions(fp, 'self')).toEqual([
      { id: 'a', label: '', source: 'created' },
      { id: 'b', label: 'b', source: 'referenced' },
    ]);
  });

  it('exclut TOUJOURS la session courante', () => {
    const fp = mk('self', [
      { type: 'assistant', message: { content: [{ type: 'text', text: '[moi-même](/session/self) et [autre](/session/other)' }] } },
    ]);
    expect(buildSubSessions(fp, 'self')).toEqual([{ id: 'other', label: 'autre', source: 'referenced' }]);
  });

  it('ignore les lignes sidechain (sous-agent)', () => {
    const fp = mk('sidechain', [
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '[x](/session/x)' }] } },
    ]);
    expect(buildSubSessions(fp, 'self')).toEqual([]);
  });

  it('transcript absent → liste vide (jamais d\'exception)', () => {
    expect(buildSubSessions('/does/not/exist.jsonl', 'self')).toEqual([]);
  });
});
