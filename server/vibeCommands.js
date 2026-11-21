/*
 * Auto-complétion des commandes « / » pour le provider vibe (Mistral Vibe).
 * Trois sources fusionnées, même contrat que server/commands.js ({name, description, group}) :
 *   1. custom  — prompts .vibe/prompts/*.md (projet + ~/.vibe/prompts) ;
 *   2. skill   — skills user-invocables (SKILL.md frontmatter) des dossiers usuels de Vibe ;
 *   3. builtin — liste curée des commandes internes de Vibe + liste live envoyée par la
 *                session pilotée via ACP (session/update availableCommands).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeCommands, matchCommands } from './commands.js';
import { readdirSafe, statSafe } from './util.js';

const VIBE_HOME = process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');

// Commandes internes de Vibe (curées, descriptions EN courtes — même esprit que CURATED).
const VIBE_BUILTIN = [
  ['help', 'Show help and available commands'],
  ['config', 'Open the settings browser'],
  ['model', 'Select active model'],
  ['thinking', 'Select thinking level'],
  ['theme', 'Select UI theme'],
  ['reload', 'Reload configuration, skills and agents from disk'],
  ['clear', 'Start a new conversation'],
  ['new', 'Start a new conversation'],
  ['resume', 'Browse and resume past sessions for this folder'],
  ['rename', 'Set a manual session title'],
  ['compact', 'Compact the context by summarizing'],
  ['retry', 'Run again a failed or interrupted response'],
  ['rewind', 'Rewind to a previous message'],
  ['branch', 'Fork the conversation into a new session'],
  ['loop', 'Schedule a recurring prompt'],
  ['goal', 'Give the session a durable goal'],
  ['pr', 'List the session pull requests / merge requests'],
  ['status', 'Display agent statistics'],
  ['context', 'Show what fills the context window'],
  ['whoami', 'Display the signed-in user, workspace and plan'],
  ['mcp', 'Display MCP servers and connector status'],
  ['skills', 'Browse and manage skills'],
  ['plugins', 'Display the plugins this session is running'],
  ['trusted-folders', 'Browse trusted folders'],
  ['voice', 'Configure voice mode'],
  ['copy', 'Copy the last agent message to the clipboard'],
  ['raw', 'Show agent messages as raw Markdown'],
  ['exit', 'Exit Vibe'],
];

// frontmatter YAML minimal d'un SKILL.md / prompt .md : name, description, user-invocable
function frontmatter(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return {}; }
  const m = data.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// prompts custom Vibe : <cwd>/.vibe/prompts/*.md (projet) + ~/.vibe/prompts/*.md (global)
function vibePromptCommands(cwd) {
  const out = [];
  const dirs = [];
  if (cwd) dirs.push(path.join(cwd, '.vibe', 'prompts'));
  dirs.push(path.join(VIBE_HOME, 'prompts'));
  const seen = new Set();
  for (const d of dirs) {
    for (const f of readdirSafe(d)) {
      if (!f.endsWith('.md')) continue;
      const fp = path.join(d, f);
      const st = statSafe(fp);
      if (!st || !st.isFile()) continue;
      const name = f.replace(/\.md$/, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const fm = frontmatter(fp);
      out.push({ name, description: fm.description || '', group: 'custom' });
    }
  }
  return out;
}

// skills user-invocables : <cwd>/.vibe/skills, <cwd>/.agents/skills, ~/.vibe/skills, ~/.agents/skills
function vibeSkillCommands(cwd) {
  const out = [];
  const seen = new Set();
  const roots = [];
  if (cwd) { roots.push(path.join(cwd, '.vibe', 'skills'), path.join(cwd, '.agents', 'skills')); }
  roots.push(path.join(VIBE_HOME, 'skills'), path.join(os.homedir(), '.agents', 'skills'));
  for (const root of roots) {
    for (const d of readdirSafe(root)) {
      const fp = path.join(root, d, 'SKILL.md');
      const st = statSafe(fp);
      if (!st || !st.isFile()) continue;
      const fm = frontmatter(fp);
      const name = fm.name || d;
      if (seen.has(name)) continue;
      if (fm['user-invocable'] === 'false') continue;
      seen.add(name);
      out.push({ name, description: fm.description || '', group: 'skill' });
    }
  }
  return out;
}

function vibeBuiltinCommands() {
  return VIBE_BUILTIN.map(([name, description]) => ({ name, description, group: 'builtin' }));
}

// liveCommands : [{name, description}] envoyés par la session ACP (availableCommands).
function vibeSlashCommands(cwd, liveCommands) {
  const live = (liveCommands || []).map((c) => ({ name: c.name, description: c.description || '', group: 'builtin' }));
  return mergeCommands([...vibePromptCommands(cwd), ...vibeSkillCommands(cwd)], [...vibeBuiltinCommands(), ...live]);
}

export { vibeSlashCommands, vibeBuiltinCommands, vibePromptCommands, vibeSkillCommands, VIBE_BUILTIN };
