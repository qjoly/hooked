/*
 * Sous-agents qu'aucun tool_use ne déclare encore (server/subagents.js).
 *
 * Un skill lancé en commande slash délègue à un sous-agent foreground, et le CLI n'écrit le tour
 * parent — donc le `tool_use` que buildSubagents apparie — qu'une fois ce sous-agent terminé.
 * Pendant les minutes que dure une revue, la seule trace est le fichier du sous-agent lui-même.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSubagents } from '../server/index.js';

let dir, transcript;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-subagents-'));
  transcript = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(transcript, '');
  const sub = path.join(dir, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
  fs.writeFileSync(path.join(sub, 'agent-abc123.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review target: PR #1\nBe thorough.' }, timestamp: '2026-09-17T12:28:50.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reading' }] } }),
  ].join('\n') + '\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('buildSubagents — agent en cours, non déclaré par le parent', () => {
  it('le découvre depuis son propre fichier', () => {
    const [a, ...rest] = buildSubagents(transcript);
    expect(rest).toEqual([]);
    expect(a.agentId).toBe('abc123');
    expect(a.type).toBe('general-purpose');
    expect(a.running).toBe(true);
    expect(a.result).toBeNull();
    expect(a.description).toBe('Review target: PR #1');
    expect(a.ts).toBe('2026-09-17T12:28:50.000Z');
  });

  it('ne double pas un agent que le parent a déjà journalisé', () => {
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'review', prompt: 'p' } }] } }),
      JSON.stringify({ type: 'user', toolUseResult: { agentId: 'abc123' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } }),
    ].join('\n') + '\n');
    const out = buildSubagents(transcript);
    expect(out).toHaveLength(1);
    expect(out[0].running).toBeUndefined();
  });

  it('sans dossier de sous-agents, rien à découvrir', () => {
    fs.rmSync(path.join(dir, 'sess'), { recursive: true, force: true });
    expect(buildSubagents(transcript)).toEqual([]);
  });
});
