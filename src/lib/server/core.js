// Pont vers la logique métier (back). Réexporte l'agrégateur server/* — modules ESM
// stdlib (zéro dépendance) : parsing transcripts, coût, état live, tmux, stats, SSE data.
// Placé sous $lib/server → garanti server-only par SvelteKit (jamais bundlé côté client).
export * from '../../../server/index.js';
