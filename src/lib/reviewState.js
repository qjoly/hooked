// "Reviewed" ticks that follow the CONTENT, not just the file path.
//
// A tick used to be a plain set of paths: once ticked, a file stayed ticked even after Claude
// edited it again, which is exactly when it needs looking at a second time. A tick is now bound to
// a fingerprint of the diff that was on screen when it was made:
//
//   • the file is edited again      → the fingerprint moves → the tick no longer applies, in the
//                                     rail and in the "reviewed N/M" counters alike;
//   • you go back to the old state  → the fingerprint comes back → the old tick applies again (an
//     earlier prompt in Ship's turn filter, an earlier commit, the other side of a base swap).
//
// Hence a LIST of fingerprints per file: every state you signed off stays signed off.

const PER_FILE_MAX = 12; // remembered states per file — the oldest signed-off state falls off

// FNV-1a, 32-bit. These fingerprints are only ever compared to themselves, so speed and stability
// beat cryptographic strength.
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/** Fingerprint of one file's on-screen diff, from the pieces it is built of. */
export function fingerprint(parts) {
  const body = parts.map((p) => p ?? '').join('\u0000'); // NUL: no source line can contain it
  return hashText(body) + '-' + body.length.toString(36); // length: a cheap collision guard
}

/** Has `file` been signed off in the state `fp` describes? */
export function isReviewed(map, file, fp) {
  if (!fp) return false;
  const seen = map.get(file);
  return !!seen && seen.includes(fp);
}

/**
 * Tick / untick `file` in its current state. Ticking remembers the state; unticking forgets it and
 * leaves any older state ticked. Returns a NEW map (for the caller's `$state` reassignment).
 */
export function toggleReviewed(map, file, fp) {
  const next = new Map(map);
  if (!fp) return next;
  const seen = next.get(file) || [];
  if (seen.includes(fp)) {
    const rest = seen.filter((h) => h !== fp);
    rest.length ? next.set(file, rest) : next.delete(file);
  } else {
    next.set(file, [...seen, fp].slice(-PER_FILE_MAX));
  }
  return next;
}

/**
 * Storage → map. Entries written before ticks were content-bound (bare paths) are dropped: the
 * state they signed off is unknown, and honouring them would resurrect "ticked forever".
 */
export function toMap(entries) {
  const m = new Map();
  if (!Array.isArray(entries)) return m;
  for (const e of entries) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !Array.isArray(e[1])) continue;
    m.set(e[0], e[1].filter((h) => typeof h === 'string').slice(-PER_FILE_MAX));
  }
  return m;
}

/** Map → storage (plain JSON). */
export const toEntries = (map) => [...map].map(([f, hs]) => [f, hs]);
