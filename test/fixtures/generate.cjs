#!/usr/bin/env node
'use strict';
/*
 * Génère un arbre de fixtures synthétiques (mais fidèles à la forme réelle des
 * transcripts Claude Code) couvrant tous les chemins de parsing de hooked :
 * prompts, usage dédupliqué, outils, AskUserQuestion (répondue + en attente),
 * éditions de fichiers (Write/Edit/MultiEdit/NotebookEdit), sous-agents (Agent/Task
 * avec toolUseResult.usage/agentId), liens PR, sidechain, multi-jour, multi-modèle.
 *
 * Sûr à committer : aucun contenu réel. Exécuter : node test/fixtures/generate.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PROJECTS = path.join(ROOT, 'projects');
const DATA = path.join(ROOT, 'data');
const CODE = path.join(ROOT, 'code');

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const writeJsonl = (fp, rows) => { mkdirp(path.dirname(fp)); fs.writeFileSync(fp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
const writeFile = (fp, content) => { mkdirp(path.dirname(fp)); fs.writeFileSync(fp, content); };

rmrf(PROJECTS); rmrf(DATA); rmrf(CODE);

// ---------- proj-alpha : session riche ----------
const projAlpha = path.join(PROJECTS, '-Users-test-proj-alpha');
const cwdAlpha = '/Users/test/proj-alpha';
const usageBig = {
  input_tokens: 100, output_tokens: 50,
  cache_creation_input_tokens: 200, cache_read_input_tokens: 1000,
  cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 150 },
};
const alpha = [
  { type: 'mode', mode: 'normal', sessionId: 'sess-alpha' },
  // prompt humain simple
  { type: 'user', isSidechain: false, sessionId: 'sess-alpha', cwd: cwdAlpha, gitBranch: 'main',
    timestamp: '2026-06-10T10:00:00.000Z', message: { role: 'user', content: 'Première tâche: refactor le module' } },
  // assistant : texte + tool_use Bash + usage (modèle opus)
  { type: 'assistant', timestamp: '2026-06-10T10:00:05.000Z', message: { id: 'msg-1', model: 'claude-opus-4-8',
    usage: usageBig, content: [
      { type: 'text', text: 'Je lance les tests.' },
      { type: 'tool_use', id: 'tu-bash-1', name: 'Bash', input: { command: 'npm test', description: 'run tests' } },
    ] } },
  // tool_result du Bash (ne doit pas compter comme prompt)
  { type: 'user', timestamp: '2026-06-10T10:00:10.000Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu-bash-1', content: 'all tests passed' } ] } },
  // DUPLICATA du message assistant (même id) → usage ne doit PAS être recompté
  { type: 'assistant', timestamp: '2026-06-10T10:00:05.500Z', message: { id: 'msg-1', model: 'claude-opus-4-8',
    usage: usageBig, content: [ { type: 'text', text: 'Je lance les tests.' } ] } },
  // assistant : Write (édition fichier) + usage
  { type: 'assistant', timestamp: '2026-06-10T10:01:00.000Z', message: { id: 'msg-2', model: 'claude-opus-4-8',
    usage: { input_tokens: 20, output_tokens: 300 }, content: [
      { type: 'tool_use', id: 'tu-write-1', name: 'Write', input: { file_path: '/Users/test/proj-alpha/src/app.js', content: 'const a = 1;\nconst b = 2;\n' } },
    ] } },
  // assistant : Edit + MultiEdit + NotebookEdit
  { type: 'assistant', timestamp: '2026-06-10T10:02:00.000Z', message: { id: 'msg-3', model: 'claude-opus-4-8',
    usage: { input_tokens: 15, output_tokens: 120 }, content: [
      { type: 'tool_use', id: 'tu-edit-1', name: 'Edit', input: { file_path: '/Users/test/proj-alpha/src/app.js', old_string: 'const a = 1;', new_string: 'const a = 42;', replace_all: false } },
      { type: 'tool_use', id: 'tu-medit-1', name: 'MultiEdit', input: { file_path: '/Users/test/proj-alpha/src/util.js', edits: [
        { old_string: 'foo', new_string: 'bar', replace_all: true },
        { old_string: 'x', new_string: 'y' } ] } },
      { type: 'tool_use', id: 'tu-nb-1', name: 'NotebookEdit', input: { notebook_path: '/Users/test/proj-alpha/nb.ipynb', new_source: 'print(1)' } },
    ] } },
  // AskUserQuestion RÉPONDUE (ask1) puis son tool_result
  { type: 'assistant', timestamp: '2026-06-10T10:03:00.000Z', message: { id: 'msg-4', model: 'claude-opus-4-8',
    usage: { input_tokens: 10, output_tokens: 10 }, content: [
      { type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: { questions: [
        { question: 'Quel style ?', header: 'Style', multiSelect: false, options: [ { label: 'A', description: 'option A' }, { label: 'B', description: 'option B' } ] } ] } },
    ] } },
  { type: 'user', timestamp: '2026-06-10T10:03:30.000Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'ask1', content: 'A' } ] } },
  // AskUserQuestion EN ATTENTE (ask2, jamais répondue) → pendingQuestion
  { type: 'assistant', timestamp: '2026-06-10T10:04:00.000Z', message: { id: 'msg-5', model: 'claude-opus-4-8',
    usage: { input_tokens: 10, output_tokens: 10 }, content: [
      { type: 'tool_use', id: 'ask2', name: 'AskUserQuestion', input: { questions: [
        { question: 'On déploie ?', header: 'Deploy', multiSelect: true, options: [ { label: 'Oui', description: 'go' }, { label: 'Non', description: 'wait' } ] } ] } },
    ] } },
  // Sous-agent (Agent) : tool_use le lendemain + tool_result avec toolUseResult.usage/agentId
  { type: 'assistant', timestamp: '2026-06-11T09:00:00.000Z', message: { id: 'msg-6', model: 'claude-opus-4-8',
    usage: { input_tokens: 30, output_tokens: 40 }, content: [
      { type: 'tool_use', id: 'agent-call-1', name: 'Agent', input: { subagent_type: 'Explore', description: 'cherche les usages', prompt: 'Trouve tous les usages de foo' } },
    ] } },
  { type: 'user', timestamp: '2026-06-11T09:05:00.000Z',
    toolUseResult: { agentType: 'Explore', agentId: 'aaa', resolvedModel: 'claude-sonnet-4-6', totalTokens: 5000, totalToolUseCount: 7, totalDurationMs: 42000,
      usage: { input_tokens: 200, output_tokens: 800, cache_read_input_tokens: 4000 } },
    message: { role: 'user', content: [ { type: 'tool_result', tool_use_id: 'agent-call-1', content: [ { type: 'text', text: 'Trouvé 3 usages.' } ] } ] } },
  // assistant avec lien PR GitHub
  { type: 'assistant', timestamp: '2026-06-11T09:10:00.000Z', message: { id: 'msg-7', model: 'claude-opus-4-8',
    usage: { input_tokens: 5, output_tokens: 20 }, content: [ { type: 'text', text: 'PR ouverte: https://github.com/acme/repo/pull/42 et aussi https://github.com/acme/repo/pull/7' } ] } },
  // ligne sidechain (doit être ignorée en mode non-sidechain)
  { type: 'user', isSidechain: true, timestamp: '2026-06-11T09:11:00.000Z', message: { role: 'user', content: 'message interne sidechain' } },
  // titre IA
  { type: 'ai-title', aiTitle: 'Refactor alpha', sessionId: 'sess-alpha' },
  // prompt de type commande slash
  { type: 'user', isSidechain: false, timestamp: '2026-06-11T09:12:00.000Z', message: { role: 'user',
    content: '<command-name>/deploy</command-name><command-args>prod</command-args>' } },
  // caveat (doit être ignoré comme prompt)
  { type: 'user', isSidechain: false, timestamp: '2026-06-11T09:13:00.000Z', message: { role: 'user',
    content: '<local-command-caveat>ceci est un caveat</local-command-caveat>' } },
];
writeJsonl(path.join(projAlpha, 'sess-alpha.jsonl'), alpha);

// sous-agent rattaché (format récent : <proj>/<sessionId>/subagents/agent-<id>.jsonl)
const agentAaa = [
  { type: 'user', isSidechain: true, sessionId: 'sess-alpha', agentId: 'aaa', cwd: cwdAlpha,
    timestamp: '2026-06-11T09:00:30.000Z', message: { role: 'user', content: 'Trouve tous les usages de foo' } },
  { type: 'assistant', isSidechain: true, timestamp: '2026-06-11T09:01:00.000Z', message: { id: 'a-msg-1', model: 'claude-sonnet-4-6',
    usage: { input_tokens: 50, output_tokens: 100 }, content: [
      { type: 'text', text: 'Je cherche.' },
      { type: 'tool_use', id: 'a-tu-1', name: 'Grep', input: { pattern: 'foo', path: '/Users/test/proj-alpha' } },
    ] } },
  { type: 'user', isSidechain: true, timestamp: '2026-06-11T09:01:10.000Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'a-tu-1', content: 'src/app.js:1\nsrc/util.js:3' } ] } },
  { type: 'assistant', isSidechain: true, timestamp: '2026-06-11T09:02:00.000Z', message: { id: 'a-msg-2', model: 'claude-sonnet-4-6',
    usage: { input_tokens: 20, output_tokens: 60 }, content: [
      { type: 'tool_use', id: 'a-tu-2', name: 'Edit', input: { file_path: '/Users/test/proj-alpha/src/util.js', old_string: 'foo', new_string: 'foo2' } },
    ] } },
];
writeJsonl(path.join(projAlpha, 'sess-alpha', 'subagents', 'agent-aaa.jsonl'), agentAaa);

// agent orphelin à plat (doit être EXCLU de scanSessions car agentId présent)
writeJsonl(path.join(projAlpha, 'agent-orphan.jsonl'), [
  { type: 'user', isSidechain: true, sessionId: 'sess-alpha', agentId: 'orphan', cwd: cwdAlpha,
    timestamp: '2026-06-11T08:00:00.000Z', message: { role: 'user', content: 'orphan' } },
]);

// ---------- proj-beta : session simple, autre modèle/jour ----------
const projBeta = path.join(PROJECTS, '-Users-test-proj-beta');
writeJsonl(path.join(projBeta, 'sess-beta.jsonl'), [
  { type: 'user', isSidechain: false, sessionId: 'sess-beta', cwd: '/Users/test/proj-beta', gitBranch: 'feature/x',
    timestamp: '2026-06-09T14:00:00.000Z', message: { role: 'user', content: 'Corrige le bug de login' } },
  { type: 'assistant', timestamp: '2026-06-09T14:00:05.000Z', message: { id: 'b-msg-1', model: 'claude-sonnet-4-6',
    usage: { input_tokens: 80, output_tokens: 200, cache_read_input_tokens: 500 }, content: [
      { type: 'text', text: 'Corrigé.' },
      { type: 'tool_use', id: 'b-tu-1', name: 'Read', input: { file_path: '/Users/test/proj-beta/login.js' } },
    ] } },
]);

// fichier non-.jsonl (doit être ignoré par scanSessions)
writeFile(path.join(projBeta, 'notes.txt'), 'ignore me');

// ---------- events.jsonl + launches.jsonl ----------
mkdirp(DATA);
writeJsonl(path.join(DATA, 'events.jsonl'), [
  { ts: '2026-06-11T09:00:00.000Z', event: 'SessionStart', session_id: 'sess-alpha', cwd: cwdAlpha, tmux_pane: '%1' },
  { ts: '2026-06-11T09:00:10.000Z', event: 'UserPromptSubmit', session_id: 'sess-alpha', cwd: cwdAlpha, tmux_pane: '%1' },
  { ts: '2026-06-11T09:00:20.000Z', event: 'PreToolUse', session_id: 'sess-alpha', tool: 'Bash', tmux_pane: '%1' },
  { ts: '2026-06-11T09:00:30.000Z', event: 'Notification', session_id: 'sess-alpha', message: 'Claude needs your permission to use Bash' },
  // question live en attente (PreToolUse AskUserQuestion sans PostToolUse derrière)
  { ts: '2026-06-11T09:01:00.000Z', event: 'PreToolUse', session_id: 'sess-alpha', tool: 'AskUserQuestion',
    ask: [ { question: 'Live ?', header: 'L', multiSelect: false, options: [ { label: 'Oui' }, { label: 'Non' } ] } ] },
  { ts: '2026-06-09T14:00:00.000Z', event: 'Stop', session_id: 'sess-beta' },
]);
writeJsonl(path.join(DATA, 'launches.jsonl'), [
  { ts: '2026-06-11T08:59:00.000Z', tmux: 'hooked-proj-alpha-abc12', cwd: cwdAlpha, model: 'opus', effort: 'high' },
  { ts: '2026-06-11T08:59:30.000Z', tmux: 'hooked-proj-alpha-abc12', cwd: cwdAlpha, model: 'opus', effort: 'max' },
]);

// ---------- arbre de code (pour matchFiles / listFilesUnder) ----------
writeFile(path.join(CODE, 'src', 'server.js'), '// server\n');
writeFile(path.join(CODE, 'src', 'lib', 'util.js'), '// util\n');
writeFile(path.join(CODE, 'src', 'components', 'App.svelte'), '<!-- app -->\n');
writeFile(path.join(CODE, 'README.md'), '# readme\n');
writeFile(path.join(CODE, 'package.json'), '{}\n');
writeFile(path.join(CODE, 'node_modules', 'dep', 'index.js'), '// should be ignored\n');
writeFile(path.join(CODE, '.git', 'config'), 'ignored\n');

console.log('Fixtures générées dans', ROOT);
