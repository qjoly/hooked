// État GitHub d'un lien de PR (OPEN / MERGED / CLOSED), partagé par les composants qui listent
// des PRs. Un seul fetch par URL ; le cache serveur (server/ghMeta.js) fige les états terminaux.
// L'écriture est différée hors du rendu : muter un $state pendant le rendu lève state_unsafe_mutation.
const states = $state({});
const asked = new Set();

export function prState(url) {
  if (!asked.has(url)) {
    asked.add(url);
    queueMicrotask(async () => {
      try {
        const d = await (await fetch(`/api/gh?url=${encodeURIComponent(url)}`)).json();
        states[url] = String(d?.data?.state || '').toUpperCase();
      } catch { /* gh indisponible : on reste sur l'icône neutre */ }
    });
  }
  return states[url] || '';
}

export function prStateIcon(state) {
  if (state === 'MERGED') return 'pr-merged';
  if (state === 'CLOSED') return 'pr-closed';
  return 'pr';
}
