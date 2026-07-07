/*
 * Reconstruit la liste des modifications de fichiers (Edit / Write / MultiEdit / NotebookEdit)
 * faites par Claude au fil de la session, regroupées par fichier (dernier touché d'abord).
 *
 * Pour chaque fichier, on tente de rejouer les edits À REBOURS sur le contenu actuel du fichier
 * sur disque afin de retrouver son état pré-session : deux edits qui se chevauchent (la même zone
 * retouchée deux fois) fusionnent alors en UN seul diff réel, au lieu d'empiler des états
 * intermédiaires trompeurs. Si la reconstruction n'est pas fiable (fichier disparu/modifié depuis,
 * Write en milieu d'historique, notebook, trop gros), on retombe sur les ops brutes.
 */
import fs from 'node:fs';
import path from 'node:path';

const EDIT_MAX = 3000;
const WRITE_MAX = 6000;
const MERGE_MAX = 60000; // au-delà : pas de reconstruction, ops brutes

function reconstructOriginal(file, ops) {
  let final;
  try { final = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  if (final.length > MERGE_MAX) return null;
  let text = final;
  let applied = 0;
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.kind === 'notebook') return null;
    if (o.kind === 'write') {
      if (i !== 0) return null;
      text = '';
      applied++;
      continue;
    }
    // Skip an edit whose new_string is no longer present: a later overlapping edit already
    // reverted this region (near-duplicate edits at the same spot). Bailing instead would fall
    // back to raw per-edit cards and show the intermediate state twice.
    if (o.all) {
      if (o.new && text.includes(o.new)) { text = text.split(o.new).join(o.old); applied++; }
    } else {
      const idx = o.new ? text.indexOf(o.new) : -1;
      if (idx >= 0) { text = text.slice(0, idx) + o.old + text.slice(idx + o.new.length); applied++; }
    }
  }
  if (!applied || text === final || text.length > MERGE_MAX) return null;
  return { old: text, new: final };
}

function truncateOp(o) {
  if (o.kind === 'write') return { kind: 'write', content: o.content.slice(0, WRITE_MAX), ts: o.ts };
  if (o.kind === 'notebook') return { kind: 'notebook', new: o.new.slice(0, EDIT_MAX), ts: o.ts };
  return { kind: 'edit', old: o.old.slice(0, EDIT_MAX), new: o.new.slice(0, EDIT_MAX), all: o.all, ts: o.ts };
}

function buildFileChanges(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const byFile = new Map(); // path -> { file, name, tool, ops: [...], count, lastTs }
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
    const ts = j.timestamp || null;
    for (const b of j.message.content) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      const inp = b.input;
      const file = inp.file_path || inp.path || inp.notebook_path;
      if (!file) continue;
      const ops = [];
      if (b.name === 'Write') {
        ops.push({ kind: 'write', content: String(inp.content || '') });
      } else if (b.name === 'Edit') {
        ops.push({ kind: 'edit', old: String(inp.old_string || ''), new: String(inp.new_string || ''), all: !!inp.replace_all });
      } else if (b.name === 'MultiEdit' && Array.isArray(inp.edits)) {
        for (const e of inp.edits) ops.push({ kind: 'edit', old: String(e.old_string || ''), new: String(e.new_string || ''), all: !!e.replace_all });
      } else if (b.name === 'NotebookEdit') {
        ops.push({ kind: 'notebook', new: String(inp.new_source || '') });
      } else {
        continue;
      }
      const entry = byFile.get(file) || { file, name: path.basename(file), tool: b.name, ops: [], count: 0, lastTs: ts };
      for (const o of ops) entry.ops.push({ ...o, ts });
      entry.count += ops.length;
      entry.lastTs = ts || entry.lastTs;
      byFile.set(file, entry);
    }
  }
  const out = [...byFile.values()].map((e) => {
    const merged = reconstructOriginal(e.file, e.ops);
    const ops = merged
      ? [{ kind: 'edit', old: merged.old, new: merged.new, all: false, ts: e.lastTs }]
      : e.ops.slice(-40).map(truncateOp);
    return { file: e.file, name: e.name, tool: e.tool, ops, count: e.count, lastTs: e.lastTs };
  });
  out.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  return out;
}

export { buildFileChanges };
