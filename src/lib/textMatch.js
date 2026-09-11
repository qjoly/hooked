// Case- and accent-insensitive text matching behind the Settings search (filter + highlight).
export const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Occurrences of `terms` in `text`, as [start, end) offsets in the ORIGINAL string, sorted.
// The search runs on a folded copy whose length differs from the source ("é" decomposes into two
// code units that fold to one "e"), so a per-character table maps every folded position back to
// where that character starts in `text`. The end of a match is the start of the NEXT folded
// character: a trailing combining mark, which folds to nothing, thus stays inside the range and
// the whole glyph gets painted.
export function findTermRanges(text, terms) {
  const needles = [...new Set(terms.map(fold).filter(Boolean))];
  if (!text || !needles.length) return [];
  let folded = '', i = 0;
  const starts = [];
  for (const ch of text) {
    const f = fold(ch);
    for (let j = 0; j < f.length; j++) starts.push(i);
    folded += f;
    i += ch.length;
  }
  starts.push(text.length);
  const out = [];
  for (const t of needles) {
    for (let at = folded.indexOf(t); at !== -1; at = folded.indexOf(t, at + t.length)) {
      const start = starts[at], end = starts[at + t.length];
      if (end > start) out.push([start, end]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
