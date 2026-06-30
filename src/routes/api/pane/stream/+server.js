import { subscribePaneStream } from '$lib/server/core.js';

// Flux SSE temps réel d'un pane tmux (tier 2) : événements `meta` (taille), `snapshot` (écran
// initial, base64), `data` (octets bruts incrémentaux, base64), `dead` (pane fermé).
export function GET({ url }) {
  const pane = url.searchParams.get('pane');
  const encoder = new TextEncoder();
  let unsubscribe;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)); } catch (_) {}
      };
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
      unsubscribe = subscribePaneStream(pane, send);
    },
    cancel() { if (unsubscribe) unsubscribe(); },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
