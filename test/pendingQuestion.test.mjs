/*
 * pendingQuestion — une AskUserQuestion reste « en attente » tant qu'elle n'a pas été traitée.
 *
 * Bug corrigé : répondre à une AskUserQuestion en TAPANT une réponse (au lieu de choisir une
 * option) abandonne l'outil dans le TUI → Claude Code n'écrit AUCUN tool_result. L'ancienne
 * détection (« répondue = a un tool_result ») laissait alors la question `pendingQuestion` à vie :
 * carte interactive fantôme dans la conversation + session bloquée sur « Awaiting your answer ».
 * Correctif : tout prompt humain postérieur résout les questions déjà posées.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript } from '../server/transcript.js';

const tmp = [];
afterEach(() => { for (const f of tmp.splice(0)) try { fs.rmSync(f); } catch (_) {} });

function write(lines) {
  const fp = path.join(os.tmpdir(), `hooked-pq-${tmp.length}-${lines.length}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'));
  tmp.push(fp);
  return fp;
}

const ask = (id, header) => ({
  type: 'assistant', timestamp: '2026-08-14T12:00:00.000Z',
  message: { role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: `${header}?`, header }] } }],
    usage: { input_tokens: 10, output_tokens: 5 } },
});

describe('parseTranscript — pendingQuestion', () => {
  it('question posée en dernier, jamais répondue → en attente', () => {
    const s = parseTranscript(write([
      { type: 'user', timestamp: '2026-08-14T11:59:00.000Z', cwd: '/r', message: { role: 'user', content: 'go' } },
      ask('q1', 'Method'),
    ]), 'sess');
    expect(s.pendingQuestion).not.toBeNull();
    expect(s.pendingQuestion.questions[0].header).toBe('Method');
  });

  it('répondue en TAPANT (aucun tool_result) → résolue (le vrai bug)', () => {
    const s = parseTranscript(write([
      { type: 'user', timestamp: '2026-08-14T11:59:00.000Z', cwd: '/r', message: { role: 'user', content: 'go' } },
      ask('q1', 'Method'),
      { type: 'user', timestamp: '2026-08-14T12:01:00.000Z', promptSource: 'typed',
        message: { role: 'user', content: "c'est faux, il peut recevoir un lien cross-repo" } },
    ]), 'sess');
    expect(s.pendingQuestion).toBeNull();
  });

  it('répondue par tool_result (option choisie) → résolue (comportement historique)', () => {
    const s = parseTranscript(write([
      ask('q1', 'Method'),
      { type: 'user', timestamp: '2026-08-14T12:01:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'Option A' }] } },
    ]), 'sess');
    expect(s.pendingQuestion).toBeNull();
  });

  it('un message sidechain ne résout PAS la question', () => {
    const s = parseTranscript(write([
      ask('q1', 'Method'),
      { type: 'user', timestamp: '2026-08-14T12:01:00.000Z', isSidechain: true, promptSource: 'typed',
        message: { role: 'user', content: 'message interne du sous-agent' } },
    ]), 'sess');
    expect(s.pendingQuestion).not.toBeNull();
    expect(s.pendingQuestion.questions[0].header).toBe('Method');
  });

  it('un caveat de commande (texte vide après nettoyage) ne résout PAS la question', () => {
    const s = parseTranscript(write([
      ask('q1', 'Method'),
      { type: 'user', timestamp: '2026-08-14T12:01:00.000Z',
        message: { role: 'user', content: '<local-command-caveat>ceci est un caveat</local-command-caveat>' } },
    ]), 'sess');
    expect(s.pendingQuestion).not.toBeNull();
  });

  it('deux questions : la 1re répondue en tapant, la 2de en attente', () => {
    const s = parseTranscript(write([
      ask('q1', 'Style'),
      { type: 'user', timestamp: '2026-08-14T12:01:00.000Z', promptSource: 'typed',
        message: { role: 'user', content: 'plutôt comme ça' } },
      ask('q2', 'Deploy'),
    ]), 'sess');
    expect(s.pendingQuestion).not.toBeNull();
    expect(s.pendingQuestion.questions[0].header).toBe('Deploy');
  });
});
