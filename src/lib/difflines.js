// Line-level diff model for the Ship lens. Built on jsdiff's `diffLines` (Myers), turned into a
// compact segment list, then into ready-to-render rows (unified or split) with large unchanged
// gaps collapsed. No DOM here — pure data, so it stays testable and cheap.
import { diffLines } from 'diff';

const CTX = 3;           // context lines kept around a change when collapsing
const GAP_MIN = CTX * 2 + 2; // an unchanged run longer than this gets a collapsed gap

// Split a jsdiff part value into lines without the spurious trailing '' from a final newline.
function toLines(value) {
  const lines = value.split('\n');
  if (lines.length && lines[lines.length - 1] === '' && value.endsWith('\n')) lines.pop();
  return lines;
}

// jsdiff parts → segments: { type:'equal', lines } | { type:'change', del:[], add:[] }.
// Consecutive removed/added parts coalesce into one change segment (so a replaced block shows its
// deletions and additions together, not as two segments).
export function toSegments(oldStr, newStr) {
  const parts = diffLines(oldStr ?? '', newStr ?? '');
  const segs = [];
  let pending = null; // { del:[], add:[] }
  const flush = () => { if (pending) { segs.push({ type: 'change', ...pending }); pending = null; } };
  for (const p of parts) {
    if (p.added || p.removed) {
      if (!pending) pending = { del: [], add: [] };
      (p.added ? pending.add : pending.del).push(...toLines(p.value));
    } else {
      flush();
      const lines = toLines(p.value);
      if (lines.length) segs.push({ type: 'equal', lines });
    }
  }
  flush();
  return segs;
}

export function countStats(segs) {
  let adds = 0, dels = 0;
  for (const s of segs) if (s.type === 'change') { adds += s.add.length; dels += s.del.length; }
  return { adds, dels };
}

// ── unified rows ──────────────────────────────────────────────────────────────────────────────
// row: { kind:'ctx'|'add'|'del', oldNo, newNo, text } | { kind:'gap', count }
export function unifiedRows(segs) {
  const rows = [];
  let oldNo = 1, newNo = 1;
  const n = segs.length;
  segs.forEach((s, i) => {
    if (s.type === 'change') {
      for (const t of s.del) rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: t });
      for (const t of s.add) rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: t });
      return;
    }
    const lines = s.lines;
    const first = i === 0, last = i === n - 1;
    if (lines.length > GAP_MIN && !(first && last)) {
      const headKeep = first ? 0 : CTX;   // no head context before the very first segment
      const tailKeep = last ? 0 : CTX;    // no tail context after the very last segment
      const head = lines.slice(0, headKeep);
      const tail = tailKeep ? lines.slice(-tailKeep) : [];
      for (const t of head) rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: t });
      const hidden = lines.length - head.length - tail.length;
      if (hidden > 0) { rows.push({ kind: 'gap', count: hidden }); oldNo += hidden; newNo += hidden; }
      for (const t of tail) rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: t });
    } else {
      for (const t of lines) rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: t });
    }
  });
  return rows;
}

// ── split rows ────────────────────────────────────────────────────────────────────────────────
// row: { kind:'ctx'|'change'|'gap', left:{no,text}|null, right:{no,text}|null, count? }
export function splitRows(segs) {
  const rows = [];
  let oldNo = 1, newNo = 1;
  const n = segs.length;
  segs.forEach((s, i) => {
    if (s.type === 'change') {
      const m = Math.max(s.del.length, s.add.length);
      for (let k = 0; k < m; k++) {
        const l = k < s.del.length ? { no: oldNo++, text: s.del[k] } : null;
        const r = k < s.add.length ? { no: newNo++, text: s.add[k] } : null;
        rows.push({ kind: 'change', left: l, right: r });
      }
      return;
    }
    const lines = s.lines;
    const first = i === 0, last = i === n - 1;
    if (lines.length > GAP_MIN && !(first && last)) {
      const headKeep = first ? 0 : CTX;
      const tailKeep = last ? 0 : CTX;
      for (const t of lines.slice(0, headKeep)) { rows.push({ kind: 'ctx', left: { no: oldNo, text: t }, right: { no: newNo, text: t } }); oldNo++; newNo++; }
      const hidden = lines.length - headKeep - tailKeep;
      if (hidden > 0) { rows.push({ kind: 'gap', count: hidden }); oldNo += hidden; newNo += hidden; }
      for (const t of (tailKeep ? lines.slice(-tailKeep) : [])) { rows.push({ kind: 'ctx', left: { no: oldNo, text: t }, right: { no: newNo, text: t } }); oldNo++; newNo++; }
    } else {
      for (const t of lines) { rows.push({ kind: 'ctx', left: { no: oldNo, text: t }, right: { no: newNo, text: t } }); oldNo++; newNo++; }
    }
  });
  return rows;
}

// Forward-apply one Claude op to a file's text (mirror of the server's backward reconstruction).
// Lets the Ship lens replay history from the reconstructed original to show a single turn's diff.
// Unmatched edits (context changed by another turn) are left as-is — same tolerance as the server.
export function applyOp(text, o) {
  if (!o) return text;
  if (o.kind === 'write') return o.content || '';
  if (o.kind === 'notebook') return text; // structural cell edit — can't replay on text
  const oldS = o.old || '', newS = o.new || '';
  if (oldS === '') return text === '' ? newS : text; // edit-from-empty (new file)
  if (o.all) return text.split(oldS).join(newS);
  const idx = text.indexOf(oldS);
  return idx >= 0 ? text.slice(0, idx) + newS + text.slice(idx + oldS.length) : text;
}

// language tag (for src/lib/highlight.js) inferred from a file name/extension.
export function langFromName(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  const MAP = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', svelte: 'html', vue: 'html',
    py: 'py', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
    cs: 'csharp', php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh', json: 'json', jsonc: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', css: 'css', scss: 'css', html: 'html', xml: 'html',
    md: 'md', markdown: 'md', sql: 'sql',
  };
  return MAP[ext] || '';
}
