/*
 * Lecture des snapshots de statusline déposés par statusline-command.sh dans STATUS_DIR
 * (un JSON par session). Source des *vraies* données du compte : effort réel, rate limits
 * 5 h / 7 j (avec reset), remplissage de la fenêtre de contexte — qu'aucun transcript ne porte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATUS_DIR } from './config.js';
import { statSafe } from './util.js';

const cache = new Map(); // path -> { key, data }

function readStatusFile(fp) {
  const st = statSafe(fp);
  if (!st || !st.isFile()) return null;
  const key = st.mtimeMs + ':' + st.size;
  const c = cache.get(fp);
  if (c && c.key === key) return c.data;
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
  let j;
  try { j = JSON.parse(raw); } catch (_) { return null; }
  const data = { ...j, _mtime: st.mtimeMs };
  cache.set(fp, { key, data });
  return data;
}

// snapshot brut d'une session (ou null).
function sessionStatusRaw(id, statusDir = STATUS_DIR) {
  if (!/^[A-Za-z0-9._-]+$/.test(id || '')) return null;
  return readStatusFile(path.join(statusDir, id + '.json'));
}

// epoch (s ou ms) → minutes restantes avant reset (>= 0), ou null.
function resetInMin(resetsAt, now = Date.now()) {
  if (resetsAt == null) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt; // les statuslines donnent des secondes
  return Math.max(0, Math.round((ms - now) / 60000));
}

function normRl(rl, now) {
  if (!rl) return null;
  return {
    pct: rl.used_percentage == null ? null : Math.round(rl.used_percentage),
    resetsAt: rl.resets_at != null ? (rl.resets_at < 1e12 ? rl.resets_at * 1000 : rl.resets_at) : null,
    resetInMin: resetInMin(rl.resets_at, now),
  };
}

// The account a snapshot belongs to: the profile id a driven session on a profile tags it with,
// null for the default account (a terminal statusline, or a session on the default profile).
const snapshotProfile = (d) => (d && d.profile && d.profile !== 'default' ? d.profile : null);

// rate limits d'UN compte : identiques quelle que soit la session de ce compte → on prend le
// snapshot le plus récent parmi les sessions de CE compte. Préfère celui de `preferId` s'il existe
// (et s'il est bien de ce compte). `profile` = l'id du profil, null pour le compte par défaut: avec
// plusieurs comptes, le plus récent toutes sessions confondues serait celui d'un autre compte.
function accountRateLimits(preferId, statusDir = STATUS_DIR, now = Date.now(), profile = null) {
  const want = profile && profile !== 'default' ? profile : null;
  let best = preferId ? sessionStatusRaw(preferId, statusDir) : null;
  if (best && (snapshotProfile(best) !== want || !best.rate_limits)) best = null;
  let bestTs = best && best._mtime || -1;
  let names = [];
  try { names = fs.readdirSync(statusDir); } catch (_) { return null; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const d = readStatusFile(path.join(statusDir, f));
    if (d && d.rate_limits && snapshotProfile(d) === want && (d._mtime || 0) > bestTs) { best = d; bestTs = d._mtime || 0; }
  }
  if (!best || !best.rate_limits) return null;
  return {
    fiveHour: normRl(best.rate_limits.five_hour, now),
    sevenDay: normRl(best.rate_limits.seven_day, now),
    at: bestTs ? new Date(bestTs).toISOString() : null,
  };
}

// id de session dont le snapshot de statusline est le plus frais (dernier écrit) — la session
// « en cours » : plus fiable que lastActivity (aucun scan de transcript). null si aucun snapshot.
function freshestStatusId(statusDir = STATUS_DIR) {
  let bestId = null;
  let bestTs = -1;
  let names = [];
  try { names = fs.readdirSync(statusDir); } catch (_) { return null; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const d = readStatusFile(path.join(statusDir, f));
    if (d && (d._mtime || 0) > bestTs) { bestTs = d._mtime || 0; bestId = f.slice(0, -'.json'.length); }
  }
  return bestId;
}

// statut consolidé pour une session : effort réel, contexte, fast mode, + rate limits du compte.
function sessionStatus(id, statusDir = STATUS_DIR, now = Date.now()) {
  const raw = sessionStatusRaw(id, statusDir);
  // The rate limits of the session's OWN account, not of whichever account wrote last.
  const rateLimit = accountRateLimits(id, statusDir, now, snapshotProfile(raw));
  if (!raw && !rateLimit) return null;
  const cw = raw && raw.context_window;
  return {
    effort: raw && raw.effort && raw.effort.level || null,
    modelId: raw && raw.model && raw.model.id || null,
    modelName: raw && raw.model && raw.model.display_name || null,
    fastMode: raw && raw.fast_mode || false,
    context: cw ? { pct: cw.used_percentage == null ? null : Math.round(cw.used_percentage), size: cw.context_window_size || null } : null,
    rateLimit,
  };
}

export { sessionStatus, sessionStatusRaw, accountRateLimits, freshestStatusId };
