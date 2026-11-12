export function knownProjects(sessions, favorites = []) {
  const fav = new Set(favorites);
  const m = new Map();
  for (const s of sessions) {
    if (!s.project) continue;
    const cwd = s.worktreeOf || s.project;
    const native = cwd === s.project;
    const e = m.get(cwd) || { name: native ? (s.projectName || cwd) : basename(cwd), count: 0, last: '', native: false };
    e.count++;
    // a name from the main checkout beats the basename derived from one of its worktrees
    if (native && !e.native) { e.name = s.projectName || cwd; e.native = true; }
    const t = s.lastActivity || '';
    if (t > e.last) e.last = t;
    m.set(cwd, e);
  }
  for (const cwd of fav) if (!m.has(cwd)) m.set(cwd, { name: basename(cwd), count: 0, last: '', native: false });
  return [...m.entries()]
    .sort((a, b) =>
      ((fav.has(b[0]) ? 1 : 0) - (fav.has(a[0]) ? 1 : 0)) ||
      String(b[1].last).localeCompare(String(a[1].last)) || b[1].count - a[1].count)
    .map(([cwd, e]) => [cwd, e.name, fav.has(cwd)]);
}

const basename = (p) => p.split('/').pop() || p;
