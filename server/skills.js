/*
 * Skills explorer: every SKILL.md Claude Code can load, with its source (user, project, plugin).
 * Read straight from disk; the bundled skills (/simplify, /loop…) live in the binary and are not listed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';

const MAX_FILES = 200;

// Minimal YAML: `key: value` scalars plus `|` / `>` blocks and indented continuation lines,
// which is all SKILL.md frontmatter uses in practice.
export function parseSkillMd(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      meta[key] = /^[|>][+-]?$/.test(v) ? '' : v.replace(/^(["'])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = (meta[key] ? meta[key] + ' ' : '') + line.trim();
    }
  }
  return { meta, body: m[2].trim() };
}

// `<root>/<name>/SKILL.md`. statSync follows symlinks: skills installed by other tools are often linked in.
function scanRoot(root, source, extra = {}) {
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const file = path.join(root, name, 'SKILL.md');
    let raw;
    try { if (!fs.statSync(file).isFile()) continue; raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const { meta } = parseSkillMd(raw);
    out.push({
      id: file,
      name: meta.name || name,
      description: meta.description || '',
      source,
      dir: path.join(root, name),
      file,
      ...extra,
    });
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function pluginSkills() {
  const installed = readJson(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'));
  const enabled = (readJson(path.join(HOME, '.claude', 'settings.json')) || {}).enabledPlugins || {};
  const out = [];
  for (const [key, insts] of Object.entries((installed && installed.plugins) || {})) {
    const plugin = key.split('@')[0];
    for (const inst of insts || []) {
      if (!inst.installPath) continue;
      // Plugin skills are invoked as `<plugin>:<skill>`.
      for (const s of scanRoot(path.join(inst.installPath, 'skills'), 'plugin', { plugin, enabled: enabled[key] !== false })) {
        out.push({ ...s, name: `${plugin}:${s.name}` });
      }
    }
  }
  return out;
}

// `cwds`: the project directories whose `.claude/skills` should be listed too.
export function listSkills(cwds = []) {
  const projects = [...new Set(cwds)].filter((c) => typeof c === 'string' && path.isAbsolute(c)).slice(0, 100);
  const all = [
    ...scanRoot(path.join(HOME, '.claude', 'skills'), 'user'),
    ...projects.flatMap((cwd) => scanRoot(path.join(cwd, '.claude', 'skills'), 'project', { project: cwd })),
    ...pluginSkills(),
  ];
  // A session opened in the home directory would list the user skills a second time as project ones.
  return [...new Map(all.reverse().map((s) => [s.id, s])).values()].reverse();
}

function listFiles(dir, rel = '', acc = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) listFiles(dir, r, acc);
    else acc.push(r);
  }
  return acc;
}

// Only ids from the current listing resolve, so the endpoint never reads an arbitrary path.
export function readSkill(id, cwds = []) {
  const skill = listSkills(cwds).find((s) => s.id === id);
  if (!skill) return null;
  let raw = '';
  try { raw = fs.readFileSync(skill.file, 'utf8'); } catch (_) { /* vanished since the listing */ }
  const { meta, body } = parseSkillMd(raw);
  return { ...skill, meta, body, files: listFiles(skill.dir).filter((f) => f !== 'SKILL.md') };
}
