'use strict';
/*
 * Auto-complétion des commandes « / » du composer. Trois sources fusionnées :
 *   1. custom   — fichiers .claude/commands/**.md (projet + global ~/.claude/commands),
 *                 namespacés par sous-dossier (frontend/x.md → /frontend:x).
 *   2. built-in — liste curée codée en dur ici (descriptions FR fiables, toujours dispo).
 *   3. built-in extraites du binaire claude-code (JS embarqué) : on lit les déclarations
 *      `type:"local",name:"…"` du bundle pour récupérer les commandes même non curées.
 * La liste curée prime pour la description ; l'extraction complète la couverture.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { HOME } = require('./config');
const { fuzzyScore } = require('./files');

// ---------- 2. liste curée (built-in) ----------
// Descriptions courtes en français. Sert aussi de fallback si l'extraction échoue.
const CURATED = [
  ['clear', 'Effacer la conversation et libérer le contexte'],
  ['compact', 'Résumer la conversation pour libérer du contexte'],
  ['context', 'Visualiser l’usage du contexte'],
  ['config', 'Ouvrir les réglages'],
  ['model', 'Changer le modèle de la session'],
  ['effort', 'Changer l’effort de raisonnement'],
  ['cost', 'Afficher le coût et l’usage de la session'],
  ['usage', 'Afficher l’usage et les limites du plan'],
  ['resume', 'Reprendre une conversation précédente'],
  ['init', 'Générer un fichier CLAUDE.md pour le projet'],
  ['review', 'Relire une pull request'],
  ['pr-comments', 'Récupérer les commentaires d’une pull request'],
  ['agents', 'Gérer les sous-agents'],
  ['mcp', 'Gérer les serveurs MCP'],
  ['hooks', 'Éditer les hooks'],
  ['memory', 'Éditer les fichiers de mémoire (CLAUDE.md)'],
  ['permissions', 'Gérer les permissions des outils'],
  ['status', 'Afficher l’état de la session et du compte'],
  ['doctor', 'Diagnostiquer l’installation de Claude Code'],
  ['add-dir', 'Ajouter un dossier de travail'],
  ['output-style', 'Changer le style de sortie'],
  ['terminal-setup', 'Configurer le terminal pour Claude Code'],
  ['vim', 'Activer le mode d’édition vim'],
  ['theme', 'Changer le thème'],
  ['export', 'Exporter la conversation'],
  ['bug', 'Signaler un bug à Anthropic'],
  ['feedback', 'Envoyer un retour'],
  ['release-notes', 'Afficher les notes de version'],
  ['install-github-app', 'Installer l’app GitHub'],
  ['login', 'Se connecter à son compte'],
  ['logout', 'Se déconnecter'],
  ['upgrade', 'Mettre à jour son plan'],
  ['privacy-settings', 'Réglages de confidentialité'],
  ['help', 'Afficher l’aide et les commandes disponibles'],
  ['exit', 'Quitter Claude Code'],
];

// noms clairement internes/cachés à exclure de l'extraction
const INTERNAL = new Set(['daemon', 'heapdump', 'bridge-kick', 'init-verifiers',
  'reload-plugins', 'reload-skills', 'remote-env', 'remote-control', 'tui', 'radio',
  'pro-trial-expired', 'rate-limit-options', 'autocompact', 'toggle-memory']);

// ---------- 3. extraction depuis le binaire claude ----------
let _binCache = null;       // { path, mtime } résolution du binaire
let _extractCache = null;   // { path, mtime, list } commandes extraites

function resolveClaudeBin() {
  if (_binCache !== null) return _binCache;
  let resolved = null;
  try {
    const which = cp.execSync('command -v claude', { encoding: 'utf8' }).trim();
    if (which) {
      // suit les symlinks jusqu'au binaire réel (.exe natif embarquant le bundle JS, ou cli.js)
      const real = cp.execSync('readlink -f ' + JSON.stringify(which), { encoding: 'utf8' }).trim();
      resolved = real || which;
    }
  } catch (_) { /* claude absent du PATH */ }
  _binCache = resolved;
  return resolved;
}

// Scanne le bundle pour les déclarations `type:"local|local-jsx|prompt",name:"…"[,description:"…"]`.
// grep -a traite le binaire comme du texte ; sortie minuscule → parse en JS. Mise en cache (mtime).
function extractBuiltins() {
  const bin = resolveClaudeBin();
  if (!bin) return [];
  let st;
  try { st = fs.statSync(bin); } catch (_) { return []; }
  const mtime = st.mtimeMs;
  if (_extractCache && _extractCache.path === bin && _extractCache.mtime === mtime) return _extractCache.list;
  let out = '';
  try {
    out = cp.execFileSync('grep', [
      '-aoE', 'type:"(local|local-jsx|prompt)",name:"[a-z][a-z0-9:_-]*"(,description:"[^"]{1,160}")?', bin,
    ], { encoding: 'utf8', maxBuffer: 8 << 20 });
  } catch (e) {
    // grep renvoie 1 si aucune correspondance ; sinon on récupère ce qui a été lu
    out = (e && e.stdout) ? String(e.stdout) : '';
  }
  const seen = new Map();
  const re = /name:"([a-z][a-z0-9:_-]*)"(?:,description:"([^"]*)")?/;
  for (const line of out.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const name = m[1];
    if (name.includes('__') || INTERNAL.has(name)) continue;
    if (!seen.has(name)) seen.set(name, m[2] || '');
  }
  const list = [...seen].map(([name, description]) => ({ name, description }));
  _extractCache = { path: bin, mtime, list };
  return list;
}

// ---------- built-in fusionnées (curée prioritaire pour la description) ----------
function builtinCommands() {
  const byName = new Map();
  for (const [name, description] of CURATED) byName.set(name, { name, description, group: 'builtin' });
  for (const { name, description } of extractBuiltins()) {
    if (byName.has(name)) continue;                 // curée prime
    byName.set(name, { name, description, group: 'builtin' });
  }
  return [...byName.values()];
}

// ---------- 1. commandes custom : .claude/commands, skills, plugins installés ----------
function listMd(root, prefix = '', acc = [], depth = 0) {
  if (depth > 6) return acc;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) listMd(full, prefix + e.name + ':', acc, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) acc.push({ file: full, name: prefix + e.name.slice(0, -3) });
  }
  return acc;
}
// frontmatter `name:`/`description:` sinon 1re ligne non vide du corps comme description.
function parseFrontmatter(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  let name = null, description = '', body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end >= 0) {
      const fm = raw.slice(3, end);
      const dm = fm.match(/(^|\n)\s*description\s*:\s*(.+)/i);
      if (dm) description = dm[2].trim().replace(/^["']|["']$/g, '');
      const nm = fm.match(/(^|\n)\s*name\s*:\s*(.+)/i);
      if (nm) name = nm[2].trim().replace(/^["']|["']$/g, '');
      body = raw.slice(end + 4);
    }
  }
  if (!description) for (const line of body.split('\n')) { const t = line.trim(); if (t) { description = t.replace(/^#+\s*/, ''); break; } }
  return { name, description: description.slice(0, 160) };
}
// .claude/commands/**.md — namespacés par sous-dossier (frontend/x.md → frontend:x).
function commandsDir(root, source) {
  return listMd(root).map(({ file, name }) => ({ name, description: (parseFrontmatter(file) || {}).description || '', group: 'custom', source }));
}
// skills — dossier `<nom>/SKILL.md` ou fichier `<nom>.md`. Nom = frontmatter `name` sinon basename.
function skillsDir(root, source) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    let file = null, base = e.name;
    if (e.isDirectory()) { const sk = path.join(root, e.name, 'SKILL.md'); if (fs.existsSync(sk)) file = sk; }
    else if (e.isFile() && e.name.endsWith('.md')) { file = path.join(root, e.name); base = e.name.slice(0, -3); }
    if (!file) continue;
    const fm = parseFrontmatter(file) || {};
    out.push({ name: fm.name || base, description: fm.description || '', group: 'custom', source });
  }
  return out;
}
// commandes des plugins installés (installed_plugins.json → <installPath>/commands/**.md).
function pluginCommandsList() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const [key, arr] of Object.entries((cfg && cfg.plugins) || {})) {
    const plugin = key.split('@')[0];
    for (const inst of arr || []) {
      for (const { file, name } of listMd(path.join(inst.installPath || '', 'commands'))) {
        out.push({ name, description: (parseFrontmatter(file) || {}).description || '', group: 'custom', source: plugin });
      }
    }
  }
  return out;
}
const _customCache = new Map(); // cwd -> { at, list }
function customCommands(cwd) {
  const key = cwd || '';
  const c = _customCache.get(key);
  const now = Date.now();
  if (c && now - c.at < 10000) return c.list;
  const byName = new Map();
  const add = (arr) => { for (const cmd of arr) byName.set(cmd.name, cmd); };
  // priorité croissante (dernier écrit gagne) : plugins < skills < commands global < commands projet
  add(pluginCommandsList());
  add(skillsDir(path.join(HOME, '.claude', 'skills'), 'skill'));
  if (cwd) add(skillsDir(path.join(cwd, '.claude', 'skills'), 'skill'));
  add(commandsDir(path.join(HOME, '.claude', 'commands'), 'global'));
  if (cwd) add(commandsDir(path.join(cwd, '.claude', 'commands'), 'projet'));
  const list = [...byName.values()];
  _customCache.set(key, { at: now, list });
  return list;
}

// ---------- API ----------
function slashCommands(cwd) {
  return [...customCommands(cwd), ...builtinCommands()];
}
// filtre + classement flou sur le nom. q sans le « / ». Custom avant built-in à égalité.
function matchCommands(list, q, limit = 30) {
  q = (q || '').toLowerCase().trim();
  if (!q) {
    return list.slice().sort((a, b) =>
      (a.group === b.group ? 0 : a.group === 'custom' ? -1 : 1) || a.name.localeCompare(b.name)
    ).slice(0, limit);
  }
  const scored = [];
  for (const c of list) {
    const s = fuzzyScore(c.name, q);
    if (s == null) continue;
    scored.push([c, s + (c.group === 'custom' ? -0.5 : 0)]); // léger biais custom
  }
  scored.sort((a, b) => a[1] - b[1] || a[0].name.length - b[0].name.length);
  return scored.slice(0, limit).map((x) => x[0]);
}

module.exports = { CURATED, resolveClaudeBin, extractBuiltins, builtinCommands, customCommands, slashCommands, matchCommands };
