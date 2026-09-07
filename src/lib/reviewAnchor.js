// Re-anchoring of review threads after the code moved (typically: Claude's fix, addressing the
// very comment, shifts or rewrites the commented lines). A thread stores its anchor (side,
// start–end) AND the exact snippet it was about; the anchor is only trusted when the snippet
// still matches the content on screen. Otherwise:
//   • the snippet is found ONCE elsewhere on that side → the thread follows its code (display
//     shift only — the stored anchor stays the historical truth);
//   • gone, or ambiguous (several occurrences) → `outdated`, and the thread is shown in a
//     dedicated section at the head of the diff instead of pinned to a wrong line.
// Threads without a snippet (never the case for new ones) keep their anchor unverified.

/**
 * @param {{ start: number, end: number, snippet?: string }} thread
 * @param {string[]} sideLines content of the thread's side, split into lines
 * @returns {{ start: number, end: number, outdated: boolean }}
 */
export function reanchor(thread, sideLines) {
  const { start, end } = thread;
  const snippet = thread.snippet || '';
  if (!snippet) return { start, end, outdated: false };
  const snip = snippet.split('\n');
  const n = snip.length;
  const matchesAt = (i) => {
    if (i < 0 || i + n > sideLines.length) return false;
    for (let k = 0; k < n; k++) if (sideLines[i + k] !== snip[k]) return false;
    return true;
  };
  if (matchesAt(start - 1)) return { start, end: start - 1 + n, outdated: false };
  const hits = [];
  for (let i = 0; i + n <= sideLines.length && hits.length < 2; i++) {
    if (sideLines[i] === snip[0] && matchesAt(i)) hits.push(i);
  }
  if (hits.length === 1) return { start: hits[0] + 1, end: hits[0] + n, outdated: false };
  return { start, end, outdated: true };
}
