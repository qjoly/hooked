// Draft reviews, so an in-progress review is not lost when focus moves elsewhere.
//
// The Ship and Branch lenses hold a review in component state: the batched inline comments and
// the per-file "reviewed" ticks. Both die the moment the component unmounts — switching to the
// Terminal tab, opening another session, or reloading the page threw away everything not yet
// sent to Claude. This mirrors that state into localStorage under a key identifying the review
// (lens + session), and hands it back on the way in.
//
// The store is a plain object keyed by review. Each entry carries a write sequence `seq` (and an
// `at` timestamp, for the curious) so the least recently written fall off once there are more
// than MAX_DRAFTS — a browser profile should not accumulate every review ever started. Eviction
// goes by `seq`, not by `at`: several reviews touched inside the same millisecond share a
// timestamp, and ordering by it would drop an arbitrary one — including the newest.

const LS_KEY = 'hooked.reviewDrafts';
const MAX_DRAFTS = 20;

const EMPTY = { comments: [], reviewed: [] };
const hasLS = () => typeof localStorage !== 'undefined';

function readStore() {
  if (!hasLS()) return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  if (!hasLS()) return;
  // Least recently written first out: keep the newest MAX_DRAFTS entries.
  const keys = Object.keys(store).sort((a, b) => (store[b].seq || 0) - (store[a].seq || 0));
  for (const k of keys.slice(MAX_DRAFTS)) delete store[k];
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // Out of quota (a review with big snippets): sacrifice the other drafts rather than lose
    // the one being written right now.
    try {
      const newest = keys[0];
      localStorage.setItem(LS_KEY, JSON.stringify(newest ? { [newest]: store[newest] } : {}));
    } catch {}
  }
}

/** The saved review for `key`, or empty lists when there is none. */
export function loadDraft(key) {
  if (!key) return { ...EMPTY };
  const d = readStore()[key];
  if (!d) return { ...EMPTY };
  return {
    comments: Array.isArray(d.comments) ? d.comments : [],
    reviewed: Array.isArray(d.reviewed) ? d.reviewed : [],
  };
}

/** Mirror a review under `key`. An empty review (nothing pending, nothing ticked) drops it. */
export function saveDraft(key, { comments = [], reviewed = [] } = {}) {
  if (!key || !hasLS()) return;
  const store = readStore();
  if (!comments.length && !reviewed.length) {
    if (!(key in store)) return;
    delete store[key];
  } else {
    const seq = Object.values(store).reduce((m, d) => Math.max(m, d.seq || 0), 0) + 1;
    store[key] = { at: Date.now(), seq, comments, reviewed };
  }
  writeStore(store);
}
