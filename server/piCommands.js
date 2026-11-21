/*
 * Auto-complétion des commandes « / » pour le provider pi.
 * Sources fusionnées, même contrat que server/commands.js ({name, description, group}) :
 *   1. custom  — prompts .pi/prompts/*.md (projet + ~/.pi/agent/prompts) ;
 *   2. skill   — skills user-invocables (.pi/skills, ~/.pi/agent/skills) ;
 *   3. builtin — liste curée des commandes internes de pi.
 * (Pas de « live commands » côté pi : pas de canal de notification de commandes en RPC.)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeCommands, matchCommands } from './commands.js';
import { readdirSafe, statSafe } from './util.js';

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

// Commandes internes de pi (curées, descriptions courtes).
const PI_BUILTIN = [
  ['help', 'Show help and available commands'],
  ['model', 'Select the active model'],
  ['thinking', 'Select the thinking level'],
  ['mcp', 'List MCP servers and their state'],
  ['skills', 'Browse and load skills'],
  ['prompts', 'List prompt templates'],
  ['compact', 'Compact the context by summarizing'],
  ['resume', 'Open the session picker'],
  ['new', 'Start a new session'],
  ['fork', 'Fork the conversation into a new session'],
  ['clone', 'Clone the active branch into a new session'],
  ["name", "Set the session display name"],
  ['tree', 'Navigate the session tree'],
  ['export', 'Export the session as HTML or JSONL'],
  ['share', 'Share the session'],
  ['login', 'Sign in to a provider'],
  ['logout', 'Sign out of a provider'],
  ['reload', 'Reload settings, extensions and resources'],
  ['clear', 'Clear the conversation'],
  ['quit', 'Exit pi'],
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

function piPromptCommands(cwd) {
  const dirs = [];
  if (cwd) dirs.push(path.join(cwd, '.pi', 'prompts'));
  dirs.push(path.join(PI_AGENT_DIR, 'prompts'));
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    for (const f of readdirSafe(d)) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const fm = frontmatter(path.join(d, f));
      out.push({ name, description: fm.description || '', group: 'custom' });
    }
  }
  return out;
}

function piSkillCommands(cwd) {
  const dirs = [];
  if (cwd) dirs.push(path.join(cwd, '.pi', 'skills'));
  dirs.push(path.join(PI_AGENT_DIR, 'skills'));
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    for (const sub of readdirSafe(d)) {
      const skillMd = path.join(d, sub, 'SKILL.md');
      if (!statSafe(skillMd)?.isFile()) continue;
      if (seen.has(sub)) continue;
      seen.add(sub);
      const fm = frontmatter(skillMd);
      if (fm['user-invocable'] === 'false') continue;
      out.push({ name: 'skill:' + sub, description: fm.description || sub, group: 'skill' });
    }
  }
  return out;
}

function piSlashCommands(cwd) {
  const builtin = PI_BUILTIN.map(([name, description]) => ({ name, description, group: 'builtin' }));
  return mergeCommands([piPromptCommands(cwd), piSkillCommands(cwd), builtin]);
}

export { piSlashCommands, matchCommands };
