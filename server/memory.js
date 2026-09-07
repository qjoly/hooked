/*
 * Mémoire persistante de Claude Code : chaque projet a un dossier
 * ~/.claude/projects/<slug>/memory/ contenant un fichier .md par fait
 * (frontmatter name/description/metadata.type + corps markdown), plus un
 * MEMORY.md d'index. On agrège tout ça pour l'onglet « Memory » du dashboard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';

const TYPES = ['user', 'feedback', 'project', 'reference'];

// Parse le frontmatter YAML minimal en tête d'un .md mémoire. Zéro dépendance :
// on ne gère que ce que le format mémoire produit (scalaires + un bloc metadata
// indenté), pas du YAML général.
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  let inMeta = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, rawVal] = kv;
    const val = rawVal.replace(/^["']|["']$/g, '').trim();
    if (inMeta && indent.length > 0) (meta.metadata ||= {})[key] = val;
    else { inMeta = false; meta[key] = val; }
  }
  return { meta, body: m[2].trim() };
}

// Slug de dossier (`-Users-qjoly-code-perso-hooked`) → chemin réel du projet.
// Le slug est ambigu (les `-` d'un vrai nom de dossier sont indistinguables des
// séparateurs), donc on lit le cwd exact dans la 1re ligne d'un transcript ;
// fallback sur le dernier segment du slug pour l'affichage.
function projectInfo(dir, slug) {
  let cwd = null;
  try {
    // Le cwd vit dans les entrées transcript ; certains .jsonl sont des sidecars
    // sans cwd (ex. `last-prompt`) → on scanne un bout de chaque fichier jusqu'à
    // trouver la 1re occurrence.
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fd = fs.openSync(path.join(dir, f), 'r');
      const buf = Buffer.alloc(16384);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = /"cwd"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      if (m) { cwd = m[1]; break; }
    }
  } catch (_) {}
  const name = cwd ? path.basename(cwd) : (slug.replace(/^-/, '').split('-').pop() || slug);
  return { cwd, name };
}

function readProjectMemories(projectsDir, slug) {
  const memDir = path.join(projectsDir, slug, 'memory');
  let files;
  try { files = fs.readdirSync(memDir); } catch (_) { return null; }
  const memories = [];
  let index = null;
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(memDir, f), 'utf8'); } catch (_) { continue; }
    if (f === 'MEMORY.md') { index = raw.trim(); continue; }
    const { meta, body } = parseFrontmatter(raw);
    const type = (meta.metadata && meta.metadata.type) || 'reference';
    memories.push({
      file: f,
      name: meta.name || f.replace(/\.md$/, ''),
      description: meta.description || '',
      type: TYPES.includes(type) ? type : 'reference',
      originSessionId: (meta.metadata && meta.metadata.originSessionId) || null,
      body,
    });
  }
  if (!memories.length && !index) return null;
  const { cwd, name } = projectInfo(path.join(projectsDir, slug), slug);
  memories.sort((a, b) => a.name.localeCompare(b.name));
  return { slug, name, cwd, index, memories };
}

// Toutes les mémoires, groupées par projet. `projectsDir` overridable pour les tests.
export function readAllMemories(projectsDir = PROJECTS_DIR) {
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch (_) { return { projects: [], total: 0, byType: {} }; }
  const projects = [];
  const byType = { user: 0, feedback: 0, project: 0, reference: 0 };
  for (const slug of slugs) {
    const p = readProjectMemories(projectsDir, slug);
    if (!p) continue;
    for (const mem of p.memories) byType[mem.type]++;
    projects.push(p);
  }
  projects.sort((a, b) => b.memories.length - a.memories.length || a.name.localeCompare(b.name));
  const total = projects.reduce((n, p) => n + p.memories.length, 0);
  return { projects, total, byType };
}
