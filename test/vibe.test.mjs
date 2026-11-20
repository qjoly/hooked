/*
 * Provider "vibe" : parse des sessions Mistral Vibe (server/vibe.js) sur fixture
 * (test/fixtures/vibe-session). Le résumé doit avoir la même shape que ceux de
 * server/transcript.js (blankSummary) + provider/dir, pour que stats.js les traite
 * sans distinction.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanVibeSessions, getVibeSession, buildVibeConversation, vibeUsageToAnthropic } from '../server/index.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'vibe-session');
const SESS = path.join(FIX, 'sess-abc123');

describe('scanVibeSessions', () => {
  it('produit un résumé compatible blankSummary, provider vibe, et exclut les sous-agents', () => {
    const all = scanVibeSessions(FIX);
    expect(all.map((s) => s.id)).toEqual(['sess-abc123']); // sess-sub a un parent_session_id
    const s = all[0];
    expect(s.provider).toBe('vibe');
    expect(s.dir).toBe(SESS);
    expect(s.file).toBe(path.join(SESS, 'journal'));
    // meta.json
    expect(s.project).toBe('/tmp/proj-vibe');
    expect(s.projectName).toBe('proj-vibe');
    expect(s.gitBranch).toBe('main');
    expect(s.title).toBe('Ma session vibe');
    expect(s.sessionIdInternal).toBe('sess-abc123');
    // entrées du journal
    expect(s.userPrompts).toBe(2);
    expect(s.firstPrompt).toBe('Premier prompt');
    expect(s.lastPrompt).toBe('Deuxième prompt');
    expect(s.assistantTurns).toBe(1);
    // replace_entry a écrasé rs-2 : la dernière réponse éditée gagne
    expect(s.lastReply).toBe('Voici la réponse éditée');
    expect(s.tools).toEqual({ bash: 1 });
    // timestamps : startTs = min(meta.start_time, entries) ; lastTs = max entry
    expect(s.startTs).toBe('2026-11-20T09:00:00.000Z');
    expect(s.lastTs).toBe(new Date(1795168240000).toISOString());
    // usage de la completion, mappé sur la shape Anthropic
    expect(s.usage).toEqual({ input: 1000, output: 50, cacheCreate: 100, cacheRead: 500 });
    expect(s.cost).toBeGreaterThan(0);
    expect(s.costBreak.input + s.costBreak.output + s.costBreak.cacheCreate + s.costBreak.cacheRead).toBeCloseTo(s.cost, 10);
    const day = new Date(1795168240000).toISOString().slice(0, 10);
    expect(s.byDay[day].turns).toBe(1);
    expect(s.byDay[day].cost).toBeCloseTo(s.cost, 10);
    // contexte (prompt-cache clock) dérivé de l'usage
    expect(s.lastUsage.contextTokens).toBe(1000 + 50 + 100 + 500);
  });

  it('getVibeSession est mémoïsé puis reparse quand le journal grandit', () => {
    const a = getVibeSession(SESS);
    const b = getVibeSession(SESS);
    expect(a).toBe(b); // même objet tant que mtime:size ne change pas
    const jf = path.join(SESS, 'journal', '0000000000000001.jsonl');
    const backup = fs.readFileSync(jf, 'utf8');
    try {
      fs.appendFileSync(jf, JSON.stringify({ payload: { delta: [{ op: 'append_entry', entry: { type: 'message', role: 'user', content: [{ type: 'text', text: 'Troisième prompt' }], createdAt: 1795168300000, updatedAt: 1795168300000, id: 'rs-4', sessionId: 'sess-abc123', turnId: 'turn-3', source: 'turn_start', generationStatus: 'completed' } }], watermark: 6 } }) + '\n');
      const c = getVibeSession(SESS);
      expect(c.userPrompts).toBe(3);
      expect(c.lastPrompt).toBe('Troisième prompt');
    } finally {
      fs.writeFileSync(jf, backup);
    }
  });
});

describe('buildVibeConversation', () => {
  it('reconstruit des bulles user/assistant avec les outils rattachés à la bulle assistant', () => {
    const msgs = buildVibeConversation(SESS);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[0].text).toBe('Premier prompt');
    expect(msgs[1].text).toBe('Voici la réponse éditée');
    expect(msgs[1].tools).toHaveLength(1);
    expect(msgs[1].tools[0].name).toBe('bash');
    expect(msgs[1].tools[0].input).toEqual({ command: 'ls' });
    expect(msgs[1].tools[0].status).toBe('success');
    expect(msgs[2].text).toBe('Deuxième prompt');
    expect(msgs[2].tools).toEqual([]);
  });
});

describe('vibeUsageToAnthropic', () => {
  it('mappe cache_write_tokens / cached_input_tokens vers la shape Anthropic', () => {
    expect(vibeUsageToAnthropic({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 5, cache_write_tokens: 3 }))
      .toEqual({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 });
  });
});
