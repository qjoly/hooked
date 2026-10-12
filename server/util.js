/* Utilitaires fs + extraction de texte depuis les contenus de messages/outils. */
import fs from 'node:fs';
import path from 'node:path';

const readdirSafe = (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } };
const statSafe = (p) => { try { return fs.statSync(p); } catch (_) { return null; } };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}
function cleanPrompt(t) {
  if (!t) return '';
  t = String(t);
  if (/^<local-command-caveat/.test(t)) return '';
  const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) return cmd[1].trim();
  t = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// Titre auto dérivé d'un prompt : coupe à `max` et signale la coupe par une ellipse, pour ne pas
// laisser croire que le titre s'arrête là. L'ellipse REMPLACE les derniers caractères (elle ne
// s'ajoute pas), donc le résultat ne dépasse jamais `max`.
function truncTitle(t, max) {
  t = String(t || '');
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// extrait un texte lisible d'un contenu de message (chat)
function chatText(content) {
  if (typeof content === 'string') {
    let t = content;
    if (/^<local-command-caveat/.test(t) || /<local-command-stdout>/.test(t)) return '';
    const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
    if (cmd) {
      const args = t.match(/<command-args>([^<]*)<\/command-args>/);
      return (cmd[1] + (args && args[1] ? ' ' + args[1] : '')).trim();
    }
    return t.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n').trim();
  }
  return '';
}
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const f = input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description || input.prompt;
  return f ? String(f).replace(/\s+/g, ' ').slice(0, 140) : '';
}

// texte lisible d'un tool_result (contenu string, ou tableau de blocs text/image).
function toolResultText(content) {
  if (typeof content === 'string') return content.slice(0, 4000);
  if (Array.isArray(content)) {
    const t = content.map((b) => {
      if (!b) return '';
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return '[image]';
      return '';
    }).filter(Boolean).join('\n');
    return t.slice(0, 4000);
  }
  return '';
}
// input d'un tool_use, en JSON indenté tronqué. Les très gros champs (ex. contenu d'un
// Write, déjà visible dans l'onglet Fichiers) sont coupés pour garder un payload léger.
function toolInputText(input) {
  if (input == null || typeof input !== 'object') return '';
  try {
    return JSON.stringify(input, (k, v) => (typeof v === 'string' && v.length > 1500 ? v.slice(0, 1500) + '\n… (truncated)' : v), 2).slice(0, 4000);
  } catch (_) { return ''; }
}

// Diff payload for a file-mutating tool_use (Write/Edit/MultiEdit/NotebookEdit), rendered as a
// collapsible Pierre diff in the conversation. Returns null for any other tool.
// Same op shape as server/changes.js (kind + content/old/new/all), but carried on `parts`
// (invisible to the characterization baseline, cf. test/characterization.test.mjs).
// `prevContent` : état écrasé par un Write, lu sur la ligne de résultat par l'appelant
// (`toolUseResult.originalFile`) — sans lui une réécriture intégrale se rend en fichier créé.
function toolDiffOps(toolName, input, prevContent) {
  if (!input || typeof input !== 'object') return null;
  const file = input.file_path || input.path || input.notebook_path;
  if (!file) return null;
  const ops = [];
  if (toolName === 'Write') {
    const prev = typeof prevContent === 'string' && prevContent ? prevContent.slice(0, 6000) : null;
    ops.push({ kind: 'write', content: String(input.content || '').slice(0, 6000), ...(prev ? { old: prev } : {}) });
  } else if (toolName === 'Edit') {
    ops.push({ kind: 'edit', old: String(input.old_string || '').slice(0, 3000), new: String(input.new_string || '').slice(0, 3000), all: !!input.replace_all });
  } else if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const e of input.edits) ops.push({ kind: 'edit', old: String(e.old_string || '').slice(0, 3000), new: String(e.new_string || '').slice(0, 3000), all: !!e.replace_all });
  } else if (toolName === 'NotebookEdit') {
    ops.push({ kind: 'notebook', new: String(input.new_source || '').slice(0, 3000) });
  } else {
    return null;
  }
  return { file, name: String(file).split('/').pop(), ops };
}

// Files sent to the user via the SendUserFile tool. Rendered inline in the conversation (image
// thumbnails + a click-to-expand lightbox for images, a click-to-open chip for other files).
// Returns null for any other tool. Carried on `parts` (like `diff`/`ask`, invisible to the
// characterization baseline). Paths resolve against the tool_use line's `cwd` when relative.
// The absolute path is only a display/URL hint — the serving endpoint re-derives the allowlist
// from the transcript itself (cf. server/userFiles.js), so a tampered path is never served.
const SEND_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
function toolSendFiles(toolName, input, cwd) {
  if (toolName !== 'SendUserFile' || !input || typeof input !== 'object') return null;
  const files = Array.isArray(input.files) ? input.files : [];
  const attach = input.display === 'attach'; // caller forces the download chip even for images
  const out = [];
  for (const f of files) {
    if (typeof f !== 'string' || !f) continue;
    const abs = path.isAbsolute(f) ? f : (cwd ? path.resolve(cwd, f) : f);
    const name = abs.split('/').pop();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    out.push({ path: abs, name, kind: (!attach && SEND_IMAGE_EXT.has(ext)) ? 'image' : 'file' });
  }
  if (!out.length) return null;
  return { caption: typeof input.caption === 'string' ? input.caption.slice(0, 300) : '', files: out };
}

// hooked's own show_image / show_video MCP tools (mcp/server.cjs): a picture or a recording of the
// work, rendered as a media card in the conversation. Same trust model as SendUserFile: the paths
// are display hints, /api/user-file re-derives its allowlist from the transcript.
const SHOW_TOOLS = { mcp__hooked__show_image: 'image', mcp__hooked__show_video: 'video' };
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, 30) : []);
function toolShowWork(toolName, input, cwd) {
  const kind = SHOW_TOOLS[toolName];
  if (!kind || !input || typeof input !== 'object' || typeof input.path !== 'string' || !input.path) return null;
  const abs = (f) => (typeof f === 'string' && f ? (path.isAbsolute(f) ? f : (cwd ? path.resolve(cwd, f) : f)) : '');
  const url = str(input.url, 2000);
  return {
    kind,
    path: abs(input.path),
    name: input.path.split('/').pop(),
    compare: abs(input.compare),
    title: str(input.title, 200),
    url: /^https?:\/\//i.test(url) ? url : '', // rendered as a link: no javascript: URLs
    changes: list(input.changes).map((c) => ({ title: str(c.title, 200), detail: str(c.detail, 500), at: num(c.at) })).filter((c) => c.title),
    checks: list(input.checks).map((c) => ({ name: str(c.name, 200), ok: !!c.ok, at: num(c.at) })).filter((c) => c.name),
    summary: list(input.summary).slice(0, 3).map((c) => ({ label: str(c.label, 200), ok: !!c.ok, passed: num(c.passed), total: num(c.total) })).filter((c) => c.label),
  };
}

export { readdirSafe, statSafe, textOf, cleanPrompt, truncTitle, chatText, toolDetail, toolResultText, toolInputText, toolDiffOps, toolSendFiles, toolShowWork, SHOW_TOOLS };
