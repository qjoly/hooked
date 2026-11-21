/*
 * Provider "vibe" : parse des sessions Mistral Vibe (server/vibe.js) sur fixture
 * (test/fixtures/vibe-session). Le résumé doit avoir la même shape que ceux de
 * server/transcript.js (blankSummary) + provider/dir, pour que stats.js les traite
 * sans distinction.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanVibeSessions, getVibeSession, buildVibeConversation, vibeToolOutput, vibeUsageToAnthropic } from '../server/index.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'vibe-session');
const SESS = path.join(FIX, 'sess-abc123');

describe('scanVibeSessions', () => {
  it('produit un résumé compatible blankSummary, provider vibe, exclut les sous-agents, garde les forks', () => {
    const all = scanVibeSessions(FIX);
    // sess-sub est déclaré dans child_sessions du parent → sous-agent exclu ;
    // sess-fork a un parent_session_id non déclaré → fork visible, marqué forkedFrom
    expect(all.map((s) => s.id).sort()).toEqual(['sess-abc123', 'sess-fork']);
    const fork = all.find((s) => s.id === 'sess-fork');
    expect(fork.forkedFrom).toBe('sess-abc123');
    expect(fork.provider).toBe('vibe');
    expect(fork.userPrompts).toBe(1);
    expect(all.find((s) => s.id === 'sess-abc123').forkedFrom).toBeUndefined();
    const s = all.find((x) => x.id === 'sess-abc123');
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

describe('vibeToolOutput', () => {
  it('préfère outputText quand il est renseigné (fixture ancienne forme)', () => {
    expect(vibeToolOutput({ status: 'success', outputText: 'a\nb\n' })).toBe('a\nb\n');
  });
  it('extrait stdout/stderr/returncode de state.output.structured_content (bash terminé)', () => {
    // forme réelle du journal vibe : outputText présent mais VIDE, sortie dans output.structured_content
    const st = { status: 'completed', outputText: '', output: { content: [], type: 'tool_result', structured_content: { command: 'ls', returncode: 0, stdout: 'a\nb\n', stderr: '' } } };
    expect(vibeToolOutput(st)).toBe('a\nb');
  });
  it('signale un exit code non nul et concatène stderr', () => {
    const st = { status: 'completed', output: { content: [], structured_content: { command: 'grep x', returncode: 1, stdout: 'hit', stderr: 'boom\n' } } };
    expect(vibeToolOutput(st)).toBe('[exit code 1]\nhit\nboom');
  });
  it('joint les blocs content[].text (read_file…)', () => {
    const st = { status: 'completed', output: { content: [{ type: 'text', text: 'ligne 1' }, { type: 'text', text: 'ligne 2' }], structured_content: {} } };
    expect(vibeToolOutput(st)).toBe('ligne 1\nligne 2');
  });
  it('fallback JSON lisible sur un structured_content générique, null sinon', () => {
    expect(vibeToolOutput({ status: 'completed', output: { content: [], structured_content: { path: '/tmp/x', size: 3 } } })).toBe(JSON.stringify({ path: '/tmp/x', size: 3 }, null, 2));
    expect(vibeToolOutput({ status: 'running', outputText: '' })).toBeNull();
    expect(vibeToolOutput(null)).toBeNull();
  });
});

describe('buildVibeConversation — tool bash au format réel du journal', () => {
  it('remonte input + output (structured_content) du tool dans la bulle assistant', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-tool-'));
    try {
      fs.mkdirSync(path.join(dir, 'journal'));
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session_id: 'sess-tool', start_time: '2026-11-20T09:00:00Z', environment: { working_directory: '/tmp/p' } }));
      const entry = (e) => JSON.stringify({ payload: { delta: [{ op: 'append_entry', entry: e }], watermark: 1 } }) + '\n';
      fs.writeFileSync(path.join(dir, 'journal', '0000000000000001.jsonl'), [
        entry({ type: 'message', role: 'user', id: 'm1', sessionId: 'sess-tool', createdAt: 1000, updatedAt: 1000, content: [{ type: 'text', text: 'lance ls' }] }),
        entry({ type: 'effect', id: 'e1', sessionId: 'sess-tool', createdAt: 2000, updatedAt: 4000, detail: { kind: 'tool', toolName: 'file_system.bash', input: { command: 'ls -la', timeout_seconds: 30 } }, state: { status: 'completed', outputText: '', output: { content: [], type: 'tool_result', structured_content: { command: 'ls -la', returncode: 0, stdout: 'total 0\na.txt\n', stderr: '', timed_out: false, was_truncated: false } } } }),
        entry({ type: 'message', role: 'assistant', id: 'm2', sessionId: 'sess-tool', createdAt: 5000, updatedAt: 5000, content: [{ type: 'text', text: 'Voilà le listing.\n\n- a.txt' }] }),
      ].join(''));
      const msgs = buildVibeConversation(dir);
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(msgs[1].text).toBe('Voilà le listing.\n\n- a.txt'); // \n conservés (markdown)
      expect(msgs[1].tools).toHaveLength(1);
      const t = msgs[1].tools[0];
      expect(t.name).toBe('bash');
      expect(t.input).toEqual({ command: 'ls -la', timeout_seconds: 30 });
      expect(t.status).toBe('completed');
      expect(t.output).toBe('total 0\na.txt');
      // shape ToolChip (web + desktop-rune) : detail / inputText / result
      expect(t.detail).toBe('ls -la');
      expect(t.inputText).toContain('"command": "ls -la"');
      expect(t.result).toBe('total 0\na.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('vibeUsageToAnthropic', () => {
  it('mappe cache_write_tokens / cached_input_tokens vers la shape Anthropic', () => {
    expect(vibeUsageToAnthropic({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 5, cache_write_tokens: 3 }))
      .toEqual({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 });
  });
});
