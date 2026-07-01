import { resolveBackgroundOutput, subscribeFileStream } from '$lib/server/core.js';

// Flux SSE du log (.output) d'un job de fond Bash. Le client passe `id` (session) + `taskId` ;
// le SERVEUR résout le chemin du fichier depuis les jobs détectés de la session (jamais un chemin
// fourni par le client → anti path-traversal). Événements : `seed` (queue initiale, base64),
// `data` (octets ajoutés, base64), `unavailable` (pas de log pour ce job — Monitor/Wakeup, etc.).
export function GET({ url }) {
  const id = url.searchParams.get('id');
  const taskId = url.searchParams.get('taskId');
  const file = resolveBackgroundOutput(id, taskId);
  const encoder = new TextEncoder();
  let unsubscribe;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)); } catch (_) {}
      };
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
      if (!file) { send('unavailable', ''); return; }
      unsubscribe = subscribeFileStream(file, send);
    },
    cancel() { if (unsubscribe) unsubscribe(); },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
