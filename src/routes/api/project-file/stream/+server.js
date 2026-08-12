import { subscribeProjectFile, sessionRoot, resolveInRoot } from '$lib/server/core.js';

// Flux SSE du contenu live d'un fichier projet. Le SERVEUR résout `path` sous la racine de la
// session (anti path-traversal) ; jamais un chemin brut du client. Événements : `change`
// (base64(JSON {content, mtimeMs})), `unavailable` (fichier hors projet / introuvable).
export function GET({ url }) {
  const root = sessionRoot(url.searchParams.get('id'));
  const file = root ? resolveInRoot(root, url.searchParams.get('path'), { mustExist: true }) : null;
  const encoder = new TextEncoder();
  let unsubscribe;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)); } catch (_) {}
      };
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
      if (!file) { send('unavailable', ''); return; }
      unsubscribe = subscribeProjectFile(file, send);
    },
    cancel() { if (unsubscribe) unsubscribe(); },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
