/*
 * Auto-tag sessions once their most recent linked PR has been reviewed on GitHub. Mirrors the
 * autoGitSync loop in gitOps.js: setInterval gated by a settings toggle, idempotent via
 * globalThis (survives Vite HMR). Reuses ghMeta.ghView (5 min cache, already fetches
 * reviewDecision) and the existing session-tags store (tags.js) — no new storage.
 */
import { scanSessions } from './transcript.js';
import { ghView } from './ghMeta.js';
import { readTags, setTags } from './tags.js';

// Aligned on ghMeta's own cache TTL (5 min): no point polling faster than the cached data changes.
const TICK_INTERVAL = parseInt(process.env.HOOKED_PR_REVIEW_INTERVAL || '300000', 10) || 300000;

const TAG_BY_DECISION = { APPROVED: 'pr-approved', CHANGES_REQUESTED: 'pr-changes-requested' };
const PR_REVIEW_TAGS = Object.values(TAG_BY_DECISION);

// Only the session's most recent PR link is checked (prLinks[0], cf. transcript.js) — a session
// that reopens a second PR later is expected to be about that latest one, not an older, likely
// already-merged one.
async function prReviewTick() {
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
  if (h.timer) { clearInterval(h.timer); h.timer = null; console.log('[hooked] pr-review-tags: stopped.'); }
}
// Idempotent : (dé)marre la boucle selon settings.autoPrReviewTag.
function applyPrReviewTagSetting(settings) {
  if (settings && settings.autoPrReviewTag) startPrReviewTags();
  else stopPrReviewTags();
}

export { prReviewTick, startPrReviewTags, stopPrReviewTags, applyPrReviewTagSetting };
