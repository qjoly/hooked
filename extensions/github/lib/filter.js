// GitHub view filter: a word with a `/` scopes by repo prefix (`org/` = whole org,
// `org/repo` = that repo), every other word must appear in the title or the repo.
export function ghFilter(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scopes = words.filter((w) => w.includes('/'));
  const terms = words.filter((w) => !w.includes('/'));
  const inScope = (repo) => !scopes.length || scopes.some((s) => repo.toLowerCase().startsWith(s));
  return {
    inScope,
    keep: (x) => inScope(x.repo) && terms.every((t) => x.title.toLowerCase().includes(t) || x.repo.toLowerCase().includes(t)),
  };
}
