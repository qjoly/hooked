import { readScreenshot } from '$lib/server/core.js';

// Serve a screenshot produced during a session (agent-browser capture, UI-diff shot…).
// `readScreenshot` only serves paths that the session's own transcript (or one of its sub-agents')
// read or wrote as an image — allowlist, realpath-guarded → no arbitrary file read even when the
// server is bound to 0.0.0.0.
export function GET({ url }) {
  const q = url.searchParams;
  const img = readScreenshot(q.get('session') || '', q.get('path') || '');
  if (!img) return new Response('not found', { status: 404 });
  return new Response(img.buffer, {
    headers: {
      'Content-Type': img.contentType,
      'Content-Disposition': `inline; filename="${img.name.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=10',
    },
  });
}
