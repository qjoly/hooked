// Dashboard local 100 % client : données live via /api + SSE (EventSource, browser-only).
// Pas de SSR — rien à pré-rendre côté serveur, et ça évite d'exécuter le code client au build.
export const ssr = false;
export const prerender = false;
