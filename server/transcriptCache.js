// Parsed rows only live for one `withSharedRows` call: a parsed transcript weighs several times its
// size on disk (130 MB transcripts exist), so they are never kept across requests.
import fs from 'node:fs';
import { statSafe } from './util.js';

let scope = null;

function readLines(fp) {
  let buf;
  try { buf = fs.readFileSync(fp); } catch (_) { return null; }
  return { lines: buf.toString('utf8').split('\n'), committed: buf.lastIndexOf(0x0a) + 1, bytes: buf.length };
}

function parseRows(raw) {
  if (!raw) return null;
  const rows = [];
  for (const line of raw.lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j && typeof j === 'object') rows.push(j);
  }
  return rows;
}

function scoped(fp) {
  let e = scope.get(fp);
  if (!e) scope.set(fp, (e = {}));
  return e;
}

// `committed` is the byte length up to the last '\n', for incrementalReader's offset. Null outside
// a scope.
function sharedLines(fp) {
  if (!scope) return null;
  const e = scoped(fp);
  if (e.raw === undefined) e.raw = readLines(fp);
  return e.raw;
}

// Rows are shared between builders inside a scope: never mutate them.
function transcriptRows(fp) {
  if (!scope) return parseRows(readLines(fp));
  const e = scoped(fp);
  if (e.rows === undefined) e.rows = parseRows(sharedLines(fp));
  return e.rows;
}

function withSharedRows(fn) {
  if (scope) return fn();
  scope = new Map();
  try { return fn(); } finally { scope = null; }
}

function fileSig(fp) {
  const st = fp ? statSafe(fp) : null;
  return st ? `${st.ino}:${st.size}:${st.mtimeMs}` : null;
}

// The memoized value is shared between callers: treat it as read-only.
function memoByFile(fn, max = 16) {
  const memo = new Map();
  return (fp, ...args) => {
    const sig = fileSig(fp);
    if (!sig) return fn(fp, ...args);
    const key = [fp, ...args].join('\0');
    const hit = memo.get(key);
    memo.delete(key);
    if (hit && hit.sig === sig) {
      memo.set(key, hit);
      return hit.value;
    }
    const value = fn(fp, ...args);
    memo.set(key, { sig, value });
    if (memo.size > max) memo.delete(memo.keys().next().value);
    return value;
  };
}

export { transcriptRows, sharedLines, withSharedRows, memoByFile };
