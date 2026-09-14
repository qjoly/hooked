/*
 * Message tapé PENDANT que l'agent travaille. Le CLI ne l'ouvre plus en tour user : il l'absorbe
 * dans le tour en cours (`queue-operation` `remove` / `reason:"absorbed_mid_turn"`) et le texte ne
 * vit plus que dans un enregistrement `attachment` / `queued_command`.
 *
 * Deux dérives de format simultanées nous avaient fait perdre ces messages — plus rendus nulle
 * part : `queue-operation` n'a plus de `content`, et `attachment.prompt` est passé de chaîne à
 * TABLEAU de blocs. Le format EST le contrat : la fixture est verbatim.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConversation } from '../server/conversation.js';

const FP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mid-turn.jsonl');
const msgs = buildConversation(FP);
const userBubbles = (t) => msgs.filter((m) => m.role === 'user' && m.text === t);

describe('message absorbé en cours de tour (attachment queued_command)', () => {
  it('prompt en tableau de blocs → bulle user', () => {
    const [m, ...rest] = userBubbles('tu lis bien ?');
    expect(m).toBeTruthy();
    expect(rest).toEqual([]);
    expect(m.ts).toBe('2026-09-14T10:00:05Z');
    expect(m.forkUuid).toBe('at1');
    expect(m.tools).toEqual([]);
  });

  it('prompt en chaîne (ancien format) → bulle user', () => {
    expect(userBubbles('ancien format chaine').length).toBe(1);
  });

  it('<task-notification> → ligne système bg, jamais une bulle user', () => {
    const bg = msgs.find((m) => m.role === 'system' && m.kind === 'bg');
    expect(bg.text).toBe('Tests done');
    expect(msgs.some((m) => m.role === 'user' && m.text.includes('task-notification'))).toBe(false);
  });

  it('attachment + tour user identique → une seule bulle, celle du tour user', () => {
    const b = userBubbles('deja traite');
    expect(b.length).toBe(1);
    expect(b[0].forkUuid).toBe('u2');
  });

  it('les queue-operation sans content ne produisent rien', () => {
    expect(msgs.some((m) => m.text != null && m.text.trim() === '')).toBe(false);
    expect(msgs.filter((m) => m.role === 'user').length).toBe(4); // u1, at1, at3, u2
  });
});
