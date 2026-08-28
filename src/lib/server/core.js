// Pont vers la logique métier (back). Réexporte l'agrégateur server/* — modules ESM
// stdlib (+ l'Agent SDK d'Anthropic pour le pilotage des sessions) : parsing transcripts, coût,
// état live, pilotage, stats, SSE data.
// Placé sous $lib/server → garanti server-only par SvelteKit (jamais bundlé côté client).
export * from '../../../server/index.js';
