import { addClient } from '$lib/server/live.js';

// Flux SSE temps réel : pousse « tick » à chaque évènement de hook / update de transcript.
export function GET() {
  const encoder = new TextEncoder();
  let unregister;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      unregister = addClient(controller);
    },
    cancel() {
      if (unregister) unregister();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
