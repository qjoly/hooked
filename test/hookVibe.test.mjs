/*
 * scripts/hook-vibe.cjs : mapping des hooks Mistral Vibe vers les noms d'évènements
 * normalisés de hooked (lus par server/events.js comme ceux de hook.cjs).
 * Le script est spawnéd avec un payload JSON sur stdin, comme Vibe le fait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'hook-vibe.cjs');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-vibe-hook-'));
});

function runHook(payload) {
  execFileSync('node', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, HOOKED_VIBE_DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

const base = { session_id: 's1', cwd: '/tmp/proj', transcript_path: '/tmp/proj/.vibe/session/s1', agent_name: 'accept-edits' };

describe('hook-vibe.cjs', () => {
  it('pre_tool file_system.bash → PreToolUse avec outil court', () => {
    const [e] = runHook({ ...base, hook_event_name: 'pre_tool', tool_name: 'file_system.bash', tool_input: { command: 'ls' } });
    expect(e.event).toBe('PreToolUse');
    expect(e.tool).toBe('bash');
    expect(e.tool_input).toEqual({ command: 'ls' });
    expect(e.provider).toBe('vibe');
    expect(e.session_id).toBe('s1');
    expect(e.mode).toBe('acceptEdits');
  });

  it('pre_tool ask_user_question → AskUserQuestion avec les questions (carte live)', () => {
    const questions = [{ question: 'Quel moteur ?', header: 'Choix', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }];
    const [e] = runHook({ ...base, hook_event_name: 'pre_tool', tool_name: 'self.ask_user_question', tool_input: { questions } });
    expect(e.event).toBe('PreToolUse');
    expect(e.tool).toBe('AskUserQuestion');
    expect(e.ask).toEqual(questions);
  });

  it('notification approval_requested → Notification « permission » (état attention)', () => {
    const [e] = runHook({ ...base, hook_event_name: 'notification', notification_type: 'approval_requested', tool_name: 'file_system.bash', message: 'Vibe needs your approval' });
    expect(e.event).toBe('Notification');
    expect(e.message).toMatch(/permission/);
    expect(e.tool).toBe('bash');
  });

  it('notification turn_completed → Stop ; pre_agent → UserPromptSubmit ; post_agent → Stop', () => {
    runHook({ ...base, hook_event_name: 'pre_agent', prompt: 'fais le truc' });
    runHook({ ...base, hook_event_name: 'notification', notification_type: 'turn_completed' });
    runHook({ ...base, hook_event_name: 'post_agent', response_text: 'done' });
    const evs = runHook({ ...base, hook_event_name: 'session_start', source: 'startup' });
    expect(evs.map((e) => e.event)).toEqual(['UserPromptSubmit', 'Stop', 'Stop', 'SessionStart']);
    expect(evs[0].prompt).toBe('fais le truc');
  });

  it('session_end → SessionEnd ; post_llm → VibeLLM avec usage + modèle', () => {
    runHook({ ...base, hook_event_name: 'session_end', reason: 'exit' });
    const evs = runHook({ ...base, hook_event_name: 'post_llm', model: 'mistral-medium-3.5', usage: { input_tokens: 10, output_tokens: 2 }, response_text: 'ok' });
    expect(evs.map((e) => e.event)).toEqual(['SessionEnd', 'VibeLLM']);
    expect(evs[1].model).toBe('mistral-medium-3.5');
    expect(evs[1].usage.input_tokens).toBe(10);
  });

  it('agent auto-approve → mode bypassPermissions ; stdin invalide → exit 0 sans crash', () => {
    const [e] = runHook({ ...base, agent_name: 'auto-approve', hook_event_name: 'session_start' });
    expect(e.mode).toBe('bypassPermissions');
    expect(() => runHook('pas du json {{{')).not.toThrow();
  });
});
