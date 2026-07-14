/*
 * Model & effort capabilities, derived LIVE from the installed claude binary instead of a
 * hardcoded list (which silently goes stale — e.g. a new model version, or `ultracode`).
 *
 *   - efforts : parsed from `claude --help` (the `--effort` option documents its choices), plus
 *     `ultracode` appended when the bundle implements it (session-level `/effort ultracode`, xhigh +
 *     auto-workflows — NOT among the plain --effort choices). Detected FROM THE BINARY, not a version
 *     number (ultracode shipped in 2.1.202, not the 2.1.203 first assumed → a version gate drifts).
 *   - models  : scraped from the claude bundle (same technique as commands.extractBuiltins), grouped
 *     by family, family alias first (the account default), concrete non-dated versions newest-first.
 *
 * NO hardcoded fallback: no resolvable claude → empty lists. hooked exists only to drive claude, so
 * "no claude" legitimately means "nothing to offer". The strict per-token charset checks below are
 * the anti-injection guard (values are interpolated into `claude --model/--effort` and typed into
 * `/model` / `/effort` via tmux send-keys), NOT a fallback list.
 *
 * Node stdlib only. Depends solely on commands.resolveClaudeBin() — must NOT import claudeUpdate.js
 * (claudeUpdate → stats → tmux, and tmux imports THIS module → import cycle). Hence the small inline
 * version read rather than reusing claudeUpdate.installedVersion.
 */
import fs from 'node:fs';
import cp from 'node:child_process';
import { resolveClaudeBin } from './commands.js';

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- pure parsers (unit-tested on fixtures, no binary needed) ----------

// The `--effort` option lists its choices in parentheses:
//   --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
// Return them in order; '' / unparseable → []. Each token must be lowercase alpha (anti-injection).
export function parseEffortsFromHelp(help) {
  const m = String(help || '').match(/--effort\b[\s\S]*?\(([^)]*)\)/);
  if (!m) return [];
  return m[1].split(/[,|]/).map((s) => s.trim()).filter((s) => /^[a-z]+$/.test(s));
}

// Build the grouped selector structure from a flat list of model ids (family aliases like "opus"
// plus concrete ids like "claude-opus-4-8"). Groups follow FAMILIES order; within a family the alias
// comes first (labelled "Opus (default)"), then concrete versions newest-first (labelled "4.8").
export function buildModelGroups(ids) {
  const set = new Set((ids || []).filter((s) => typeof s === 'string'));
  const verNums = (id) => (id.match(/\d+/g) || []).map(Number);
  const cmpDesc = (a, b) => {
    const va = verNums(a), vb = verNums(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] || 0) - (va[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  const groups = [];
  for (const fam of FAMILIES) {
    const opts = [];
    if (set.has(fam)) opts.push([fam, `${cap(fam)} (default)`]);
    // Concrete versions: "claude-<fam>-<major>-<minor>" (opus/sonnet/haiku) or "claude-fable-<n>".
    // Exclude bare majors ("claude-opus-4" → a meaningless "4" label) and dated snapshots (a run of
    // >=5 digits = YYYYMMDD), which the coarse bundle grep can still let through.
    const verRe = fam === 'fable' ? /^claude-fable-\d+$/ : new RegExp(`^claude-${fam}-\\d+-\\d+$`);
    const versions = [...set].filter((id) => verRe.test(id) && !/\d{5,}/.test(id)).sort(cmpDesc);
    for (const id of versions) opts.push([id, id.slice(`claude-${fam}-`.length).replace(/-/g, '.')]);
    if (opts.length) groups.push({ label: cap(fam), opts });
  }
  return groups;
}

// ---------- binary readers (cached by binary mtime → re-run only on a claude upgrade) ----------

function binStat() {
  const bin = resolveClaudeBin();
  if (!bin) return null;
  try { return { bin, mtime: fs.statSync(bin).mtimeMs }; } catch (_) { return null; }
}

// Does the claude bundle implement session-level ultracode? Grep the binary for distinctive markers
// (same read technique as fetchModelGroups). Version-agnostic → no threshold to drift. grep exits 1
// with no match → execFileSync throws; treat that (empty stdout) as "not found".
function bundleHasUltracode(bin) {
  try {
    const out = cp.execFileSync('grep', ['-aoE', 'ultracodeKeywordTrigger|ultracode \\(xhigh', bin],
      { encoding: 'utf8', maxBuffer: 1 << 20 });
    return out.trim().length > 0;
  } catch (e) { return !!(e && e.stdout && String(e.stdout).trim()); }
}

let _effortCache = null; // { bin, mtime, list }
export function fetchEfforts() {
  const bs = binStat();
  if (!bs) return [];
  if (_effortCache && _effortCache.bin === bs.bin && _effortCache.mtime === bs.mtime) return _effortCache.list;
  let list = [];
  try {
    const help = cp.execFileSync(bs.bin, ['--help'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 << 20 });
    list = parseEffortsFromHelp(help);
  } catch (_) { list = []; }
  if (list.length && !list.includes('ultracode') && bundleHasUltracode(bs.bin)) list.push('ultracode');
  _effortCache = { bin: bs.bin, mtime: bs.mtime, list };
  return list;
}

let _modelCache = null; // { bin, mtime, groups }
export function fetchModelGroups() {
  const bs = binStat();
  if (!bs) return [];
  if (_modelCache && _modelCache.bin === bs.bin && _modelCache.mtime === bs.mtime) return _modelCache.groups;
  // Scan the bundle for quoted model ids. The trailing `"` anchor excludes dated snapshots
  // (`claude-opus-4-5-20251101` has no `"` right after the `4-5`), keeping only rolling versions.
  let out = '';
  try {
    out = cp.execFileSync('grep', [
      '-aoE', '"(claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]+)?|opus|sonnet|haiku|fable)"', bs.bin,
    ], { encoding: 'utf8', maxBuffer: 8 << 20 });
  } catch (e) { out = (e && e.stdout) ? String(e.stdout) : ''; }
  const ids = new Set();
  for (const line of out.split('\n')) { const m = line.match(/"([a-z0-9-]+)"/); if (m) ids.add(m[1]); }
  const groups = buildModelGroups([...ids]);
  _modelCache = { bin: bs.bin, mtime: bs.mtime, groups };
  return groups;
}

// tmux.js validates effort against this at launch / live change (charset already enforced above).
export function isValidEffort(e) { return typeof e === 'string' && fetchEfforts().includes(e); }
