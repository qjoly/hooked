// Incremental session detail (client side). /api/session?delta=1 can answer with only what changed
// since the copy the browser already holds: the tail of `messages` (everything from `messagesFrom`
// on) and, for the heavy side lists, "unchanged" instead of the list itself. The server half lives
// in server/detailDelta.js; both agree on the field names below.

// Heavy fields that are skipped when their content hash matches what the client sent.
export const HEAVY_FIELDS = ['changes', 'workflows', 'subagents', 'screenshots', 'subSessions'];

// Query string telling the server what we already have. Only valid for a copy of the SAME session.
export function deltaQuery(prev, id) {
  const q = new URLSearchParams({ id, delta: '1' });
  const have = prev && prev.id === id && Array.isArray(prev.messages) ? prev : null;
  if (have && have.prefixSig && have.stableCount > 0 && have.messages.length >= have.stableCount) {
    q.set('since', String(have.stableCount));
    q.set('sig', have.prefixSig);
  }
  if (have && have.fieldSigs) {
    const parts = HEAVY_FIELDS.filter((k) => have.fieldSigs[k] && k in have).map((k) => `${k}.${have.fieldSigs[k]}`);
    if (parts.length) q.set('have', parts.join(','));
  }
  return q.toString();
}

// Rebuilds the full detail from a (possibly partial) response and the copy it was computed against.
// Returns null when the response cannot be completed from `prev` (caller refetches without it).
export function mergeDetail(prev, d) {
  if (!d || typeof d !== 'object') return d;
  const from = d.messagesFrom || 0;
  const unchanged = Array.isArray(d.unchanged) ? d.unchanged : [];
  if (from > 0 && (!prev || !Array.isArray(prev.messages) || prev.messages.length < from)) return null;
  if (unchanged.length && !prev) return null;
  const out = { ...d };
  if (from > 0) out.messages = prev.messages.slice(0, from).concat(d.messages || []);
  for (const k of unchanged) {
    if (!(k in prev)) return null;
    out[k] = prev[k];
  }
  delete out.unchanged;
  return out;
}
