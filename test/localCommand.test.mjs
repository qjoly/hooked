/*
 * La sortie d'une commande locale dans la conversation (server/conversation.js).
 *
 * Un skill lancé en commande slash écrit son rendu dans une ligne
 * `type:"system", subtype:"local_command"` — et nulle part ailleurs : aucun tour assistant n'est
 * journalisé dans le transcript principal. /code-review y met sa revue entière, qui n'apparaissait
 * donc nulle part : la conversation s'arrêtait sur le prompt.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildConversation } from '../server/index.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'local-command.jsonl');

describe('buildConversation — sortie de commande locale', () => {
  const msgs = buildConversation(FIXTURE);

  it('rend la sortie comme une réponse de Claude', () => {
    const m = msgs.find((x) => x.role === 'assistant');
    expect(m).toBeTruthy();
    expect(m.text).toBe('## Revue de la PR #1\n\nAucun défaut bloquant.');
    expect(m.localCommand).toBe(true);
  });

  it('la sert aussi en parts : c\'est ce que rend la bulle assistant', () => {
    const m = msgs.find((x) => x.role === 'assistant');
    expect(m.parts).toEqual([{ type: 'text', text: '## Revue de la PR #1\n\nAucun défaut bloquant.' }]);
  });

  it('garde le prompt et laisse de côté le caveat et une sortie vide', () => {
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0].text).toBe('/code-review https://github.com/o/r/pull/1');
  });
});
