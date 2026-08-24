/*
 * Reconstruit la liste des modifications de fichiers (Edit / Write / MultiEdit / NotebookEdit)
 * faites par Claude au fil de la session, regroupées par fichier (dernier touché d'abord).
 *
 * Pour chaque fichier, on tente de rejouer les edits À REBOURS sur le contenu actuel du fichier
 * sur disque afin de retrouver son état pré-session : deux edits qui se chevauchent (la même zone
 * retouchée deux fois) fusionnent alors en UN seul diff réel, au lieu d'empiler des états
 * intermédiaires trompeurs. Si la reconstruction n'est pas fiable (fichier disparu/modifié depuis,
 * Write en milieu d'historique, notebook, trop gros), on retombe sur les ops brutes.
 *
 * Les contenus sont bornés par défaut (payload du détail de session). Un fichier dont un op dépasse
 * ces bornes (ou trop gros pour la reconstruction) est marqué `truncated:true` ; la lentille Ship
 * propose alors de charger le diff COMPLET à la demande via buildFileChangeFull (caps = Infinity).
 */
import fs from 'node:fs';
import path from 'node:path';

// Default caps keep the session-detail payload lean. A file that overflows them is flagged
// `truncated` and the Ship lens offers to load the FULL diff on demand (buildFileChangeFull).
// Note: a file whose edits reconstruct cleanly shows its full net content regardless (the net
// `new` is the on-disk file, ≤ MERGE_MAX) — the caps only bound the raw-op fallback / per-prompt.
const EDIT_MAX = 12000;
const WRITE_MAX = 24000;
const MERGE_MAX = 60000; // au-delà : pas de reconstruction, ops brutes
const RAW_KEEP = 40;     // on ne garde que les N dernières ops brutes

function reconstructOriginal(file, ops, mergeMax) {
  let final;
  try { final = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  if (final.length > mergeMax) return null;
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
  if (!applied || text === final || text.length > mergeMax) return null;
  return { old: text, new: final };
}

function truncateOp(o, editMax, writeMax) {
  if (o.kind === 'write') return { kind: 'write', content: o.content.slice(0, writeMax), ts: o.ts };
  if (o.kind === 'notebook') return { kind: 'notebook', new: o.new.slice(0, editMax), ts: o.ts };
  return { kind: 'edit', old: o.old.slice(0, editMax), new: o.new.slice(0, editMax), all: o.all, ts: o.ts };
}

// A raw op is "too big" for the given caps → its content would be sliced (→ missing lines).
function opTooBig(o, editMax, writeMax) {
  if (o.kind === 'write') return (o.content || '').length > writeMax;
  if (o.kind === 'notebook') return (o.new || '').length > editMax;
  return (o.old || '').length > editMax || (o.new || '').length > editMax;
}
function diskTooBig(file, mergeMax) {
  try { return fs.statSync(file).size > mergeMax; } catch (_) { return false; }
}

// Scan a transcript into per-file ops (full, untruncated). One place both the capped list and the
// on-demand full builder go through.
function scanOps(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return new Map(); }
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
  return byFile;
}

// Build one output entry from an accumulated file entry, under the given caps.
function buildEntry(e, editMax, writeMax, mergeMax) {
  const merged = reconstructOriginal(e.file, e.ops, mergeMax);
  const ops = merged
    ? [{ kind: 'edit', old: merged.old, new: merged.new, all: false, ts: e.lastTs }]
    : e.ops.slice(-RAW_KEEP).map((o) => truncateOp(o, editMax, writeMax));
  // `original` (état pré-session reconstruit) + `rawOps` (ordonnées, horodatées) permettent au
  // client (lentille Ship) de rejouer l'historique et d'afficher le diff d'un ou plusieurs prompts.
  const rawOps = e.ops.slice(-RAW_KEEP).map((o) => ({ ...truncateOp(o, editMax, writeMax), ts: o.ts }));
  // Marqué tronqué quand un contenu a été rogné : op au-dessus des bornes, ou fichier trop gros pour
  // la reconstruction (→ fallback rogné). Faux quand les bornes sont infinies (build complet).
  const truncated = Number.isFinite(editMax)
    && (e.ops.some((o) => opTooBig(o, editMax, writeMax)) || (!merged && diskTooBig(e.file, mergeMax)));
  return { file: e.file, name: e.name, tool: e.tool, ops, count: e.count, lastTs: e.lastTs, original: merged ? merged.old : null, rawOps, truncated };
}

function buildFileChanges(fp) {
  const byFile = scanOps(fp);
  const out = [...byFile.values()].map((e) => buildEntry(e, EDIT_MAX, WRITE_MAX, MERGE_MAX));
  out.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  return out;
}

// Full (uncapped) change entry for ONE file, loaded on demand by the Ship lens when a file was
// flagged `truncated`. Infinity caps → no slicing, no size bail on reconstruction. null if the file
// wasn't touched in this transcript.
function buildFileChangeFull(fp, filePath) {
  const e = scanOps(fp).get(filePath);
  if (!e) return null;
  return buildEntry(e, Infinity, Infinity, Infinity);
}

export { buildFileChanges, buildFileChangeFull };
