import { readImage } from '$lib/server/core.js';

// Serve an attached image for display in the conversation. `readImage` restricts to hooked's images
// dir (no arbitrary file read even if the server is bound to 0.0.0.0). Names are unique + immutable.
export function GET({ url }) {
  const img = readImage(url.searchParams.get('path') || '');
  if (!img) return new Response('not found', { status: 404 });
  return new Response(img.buffer, {
    headers: {
      'Content-Type': img.contentType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
