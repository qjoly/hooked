'use strict';
/*
 * Reconstruit la liste des modifications de fichiers (Edit / Write / MultiEdit / NotebookEdit)
 * faites par Claude au fil de la session, regroupées par fichier (dernier touché d'abord).
 */
const fs = require('fs');
const path = require('path');

function buildFileChanges(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const byFile = new Map(); // path -> { file, name, ops: [...], count, lastTs }
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
        ops.push({ kind: 'write', content: String(inp.content || '').slice(0, 6000) });
      } else if (b.name === 'Edit') {
        ops.push({ kind: 'edit', old: String(inp.old_string || '').slice(0, 3000), new: String(inp.new_string || '').slice(0, 3000), all: !!inp.replace_all });
      } else if (b.name === 'MultiEdit' && Array.isArray(inp.edits)) {
        for (const e of inp.edits) ops.push({ kind: 'edit', old: String(e.old_string || '').slice(0, 3000), new: String(e.new_string || '').slice(0, 3000), all: !!e.replace_all });
      } else if (b.name === 'NotebookEdit') {
        ops.push({ kind: 'notebook', new: String(inp.new_source || '').slice(0, 3000) });
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
  // cap dur sur le nombre d'opérations affichées par fichier (sessions très longues)
  const out = [...byFile.values()].map((e) => ({ ...e, ops: e.ops.slice(-40) }));
  out.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  return out;
}

module.exports = { buildFileChanges };
