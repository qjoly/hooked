/*
 * Auto-tag sessions once their most recent linked PR has been reviewed on GitHub. Mirrors the
 * autoGitSync loop in gitOps.js: setInterval gated by a settings toggle, idempotent via
 * globalThis (survives Vite HMR). Reuses ghMeta.ghView (5 min cache, already fetches
 * reviewDecision) and the existing session-tags store (tags.js) — no new storage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';
import { scanSessions } from './transcript.js';
import { ghView } from './ghMeta.js';
import { readTags, setTags } from './tags.js';

// Aligned on ghMeta's own cache TTL: no point polling faster than the cached data changes.
const TICK_INTERVAL = parseInt(process.env.HOOKED_PR_REVIEW_INTERVAL || '300000', 10) || 300000;

// Verrou inter-process (best-effort). Plusieurs `node build` peuvent coexister (relances launchd,
// dev en parallèle…) ; chacun lançait son propre tick → N pollers GitHub simultanés qui vidaient le
// quota GraphQL. On garantit qu'un seul process poll à la fois : les autres voient un verrou vivant
// et récent, et sautent leur tick sans frapper l'API. La rare course (deux writers) coûte au pire
// quelques requêtes en double une fois, sans commune mesure avec l'amplification par N instances.
// Dans le data dir hooked (PAS os.tmpdir() global) : tous les process d'une même install le
// partagent (le verrou inter-process fonctionne), mais une install isolée par HOOKED_DATA_DIR
// (tests, dev parallèle) ne se fait pas voler son tick par le service réel de la machine.
const LOCK_FILE = path.join(HOOKED_DIR, 'pr-review.lock');
const LOCK_STALE_MS = TICK_INTERVAL * 3; // au-delà, on considère le détenteur mort ou gelé
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquirePollLock() {
  const cur = readLock();
  // Un autre process détient un verrou récent ET est toujours vivant → on lui laisse le polling.
  if (cur && cur.pid !== process.pid && pidAlive(cur.pid) && Date.now() - (cur.at || 0) < LOCK_STALE_MS) return false;
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true }); // data dir peut ne pas exister (1er run / tests)
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch { return false; }
}
function releasePollLock() {
  const cur = readLock();
  if (cur && cur.pid === process.pid) { try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } }
}

const TAG_BY_DECISION = { APPROVED: 'pr-approved', CHANGES_REQUESTED: 'pr-changes-requested' };
const PR_REVIEW_TAGS = Object.values(TAG_BY_DECISION);

// Only the session's most recent PR link is checked (prLinks[0], cf. transcript.js) — a session
// that reopens a second PR later is expected to be about that latest one, not an older, likely
// already-merged one.
async function prReviewTick() {
  if (!acquirePollLock()) return; // un autre process poll déjà GitHub → on n'ajoute pas de charge
  for (const s of scanSessions()) {
    const url = s.prLinks && s.prLinks[0];
    if (!url) continue;
    const meta = await ghView(url);
    const tag = meta && TAG_BY_DECISION[meta.reviewDecision];
    if (!tag) continue;
    const current = readTags()[s.id] || [];
    if (current.includes(tag) && !current.some((t) => t !== tag && PR_REVIEW_TAGS.includes(t))) continue; // déjà à jour
    setTags(s.id, [...current.filter((t) => !PR_REVIEW_TAGS.includes(t)), tag]);
  }
}

function handle() {
  if (!globalThis.__hookedPrReviewTags) globalThis.__hookedPrReviewTags = { timer: null };
  return globalThis.__hookedPrReviewTags;
}
function startPrReviewTags() {
  const h = handle();
  if (h.timer) return;
  console.log(`[hooked] pr-review-tags: starting (every ${Math.round(TICK_INTERVAL / 1000)}s).`);
  const run = () => { prReviewTick().catch((e) => console.warn('[hooked] pr-review-tags tick error:', e && e.message ? e.message : e)); };
  run(); // 1er passage immédiat
  h.timer = setInterval(run, TICK_INTERVAL);
  if (h.timer.unref) h.timer.unref(); // ne bloque pas la sortie du process
}
function stopPrReviewTags() {
  const h = handle();
  if (h.timer) { clearInterval(h.timer); h.timer = null; releasePollLock(); console.log('[hooked] pr-review-tags: stopped.'); }
}
// Idempotent : (dé)marre la boucle selon settings.autoPrReviewTag.
function applyPrReviewTagSetting(settings) {
  if (settings && settings.autoPrReviewTag) startPrReviewTags();
  else stopPrReviewTags();
}

export { prReviewTick, startPrReviewTags, stopPrReviewTags, applyPrReviewTagSetting };
