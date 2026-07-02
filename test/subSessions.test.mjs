/*
 * buildSubSessions — sessions sœurs créées / référencées par une conversation.
 * Fixture minimale écrite dans un tmpdir : on couvre les deux sources (created / referenced),
 * la dédup, l'exclusion de la session courante, l'ordre de première apparition, et le filtrage
 * des ids non-UUID (liens d'exemple `<id>`, `null` d'un start_session non résolu, placeholders).
 * Les ids de session hooked SONT des UUID → les fixtures en utilisent de vrais.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSubSessions } from '../server/subSessions.js';

// UUID lisibles pour les fixtures (forme canonique 8-4-4-4-12).
const SELF = '00000000-0000-4000-8000-000000000000';
const CH1 = '11111111-1111-4111-8111-111111111111';
const CH2 = '22222222-2222-4222-8222-222222222222';
const CH3 = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = '99999999-9999-4999-8999-999999999999';

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
    const fp = mk('created', startSession('tu1', `/session/${CH1}`));
    expect(buildSubSessions(fp, SELF)).toEqual([{ id: CH1, label: '', source: 'created' }]);
  });

  it('détecte une session RÉFÉRENCÉE (lien markdown dans le texte assistant)', () => {
    const fp = mk('ref', [
      { type: 'assistant', message: { content: [{ type: 'text', text: `Voir [le worker](/session/${CH2}) pour la suite.` }] } },
    ]);
    expect(buildSubSessions(fp, SELF)).toEqual([{ id: CH2, label: 'le worker', source: 'referenced' }]);
  });

  it('détecte aussi un lien dans un message utilisateur (string content)', () => {
    const fp = mk('userref', [
      { type: 'user', message: { content: `regarde [ça](/session/${CH3})` } },
    ]);
    expect(buildSubSessions(fp, SELF)).toEqual([{ id: CH3, label: 'ça', source: 'referenced' }]);
  });

  it('union dédupliquée par id, ordre de première apparition (created avant sa référence)', () => {
    const fp = mk('union', [
      ...startSession('tu1', `/session/${A}`),
      { type: 'assistant', message: { content: [{ type: 'text', text: `[a de nouveau](/session/${A}) et [b](/session/${B})` }] } },
    ]);
    // `a` vue d'abord via created → garde source:created ; `b` référencée ensuite.
    expect(buildSubSessions(fp, SELF)).toEqual([
      { id: A, label: '', source: 'created' },
      { id: B, label: 'b', source: 'referenced' },
    ]);
  });

  it('exclut TOUJOURS la session courante', () => {
    const fp = mk('self', [
      { type: 'assistant', message: { content: [{ type: 'text', text: `[moi-même](/session/${SELF}) et [autre](/session/${OTHER})` }] } },
    ]);
    expect(buildSubSessions(fp, SELF)).toEqual([{ id: OTHER, label: 'autre', source: 'referenced' }]);
  });

  it('ignore les ids non-UUID : lien d\'exemple `<id>`, `null` d\'un start_session, placeholders', () => {
    const fp = mk('garbage', [
      { type: 'assistant', message: { content: [{ type: 'text', text: `exemple \`[label](/session/<id>)\` puis [vrai](/session/${CH1})` }] } },
      ...startSession('tu9', '/session/null'),
    ]);
    // seul le vrai UUID survit ; `<id>` (exemple) et `null` (start_session non résolu) sont écartés.
    expect(buildSubSessions(fp, SELF)).toEqual([{ id: CH1, label: 'vrai', source: 'referenced' }]);
  });

  it('ignore les lignes sidechain (sous-agent)', () => {
    const fp = mk('sidechain', [
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: `[x](/session/${A})` }] } },
    ]);
    expect(buildSubSessions(fp, SELF)).toEqual([]);
  });

  it('transcript absent → liste vide (jamais d\'exception)', () => {
    expect(buildSubSessions('/does/not/exist.jsonl', SELF)).toEqual([]);
  });
});
