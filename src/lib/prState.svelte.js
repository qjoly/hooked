// GitHub metadata of a PR / issue link (title, state, author, review decision, description),
// fetched ONCE per URL and shared by everything that shows the link — the dock pills and the
// Links card used to each fetch the same URL. The write is deferred out of render: mutating a
// $state during render throws state_unsafe_mutation. The server cache (server/ghMeta.js) pins
// terminal states, so a re-fetch after a reload is cheap.
const cache = $state({});   // url → { loading, data: object | null }
const asked = new Set();
const PENDING = { loading: true, data: null };

export function ghMeta(url) {
  if (!asked.has(url)) {
    asked.add(url);
    queueMicrotask(async () => {
      cache[url] = PENDING;
      try {
        const d = await (await fetch(`/api/gh?url=${encodeURIComponent(url)}`)).json();
        cache[url] = { loading: false, data: d?.data ?? null };
      } catch {
        cache[url] = { loading: false, data: null }; // gh unavailable: the neutral rendering stays
      }
    });
  }
  return cache[url] || PENDING;
}

// OPEN / MERGED / CLOSED (uppercase), '' until known.
export function prState(url) {
  return String(ghMeta(url).data?.state || '').toUpperCase();
}

export function prStateIcon(state) {
  if (state === 'MERGED') return 'pr-merged';
  if (state === 'CLOSED') return 'pr-closed';
  return 'pr';
}
