/*
 * conversation.js — message user long : capé dans la charge utile, marqué `truncated`, et rendu
 * ENTIER à la demande par readMessageText (le « Show more » de la bulle). Miroir de
 * changesTruncation.test.mjs pour les diffs. On vérifie aussi qu'un message court garde
 * exactement sa forme d'avant (pas de drapeau parasite : la baseline de caractérisation compare
 * les objets entiers).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConversation, readMessageText } from '../server/conversation.js';

let dir, transcript;
const BIG = Array.from({ length: 500 }, (_, i) => `review comment ${i} ${'x'.repeat(40)}`).join('\n'); // > 8000
const BIG2 = Array.from({ length: 500 }, (_, i) => `queued line ${i} ${'y'.repeat(40)}`).join('\n');
const SHORT = 'ship it';
const BIG_UUID = 'u-big';
const QUEUED_UUID = 'u-queued';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-msgtrunc-'));
  transcript = path.join(dir, 'sess.jsonl');
  const lines = [
    { type: 'user', uuid: BIG_UUID, timestamp: '2026-08-20T10:00:00.000Z', message: { content: BIG } },
    { type: 'user', uuid: 'u-short', timestamp: '2026-08-20T10:01:00.000Z', message: { content: SHORT } },
    { type: 'queue-operation', uuid: QUEUED_UUID, timestamp: '2026-08-20T10:02:00.000Z', content: BIG2 },
  ].map((l) => JSON.stringify(l));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

describe('buildConversation — plafond par message', () => {
  it('cape le message long et le marque truncated', () => {
    const m = buildConversation(transcript).find((x) => x.forkUuid === BIG_UUID);
    expect(m.truncated).toBe(true);
    expect(m.text.length).toBe(8000);
    expect(BIG.length).toBeGreaterThan(8000);
  });

  it('cape aussi un message mis en file (queue-operation)', () => {
    const m = buildConversation(transcript).find((x) => x.forkUuid === QUEUED_UUID);
    expect(m.truncated).toBe(true);
    expect(m.text.length).toBe(8000);
  });

  it('laisse un message court intact, SANS drapeau ajouté', () => {
    const m = buildConversation(transcript).find((x) => x.text === SHORT);
    expect('truncated' in m).toBe(false);
  });
});

describe('readMessageText — la fin, à la demande', () => {
  it('rend le texte complet du message coupé', () => {
    expect(readMessageText(transcript, BIG_UUID)).toBe(BIG);
    expect(readMessageText(transcript, QUEUED_UUID)).toBe(BIG2);
  });

  it('renvoie null sur un uuid inconnu, un fichier absent ou un uuid vide', () => {
    expect(readMessageText(transcript, 'nope')).toBe(null);
    expect(readMessageText(path.join(dir, 'missing.jsonl'), BIG_UUID)).toBe(null);
    expect(readMessageText(transcript, '')).toBe(null);
  });
});
