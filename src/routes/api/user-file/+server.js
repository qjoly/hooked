import { readUserFile } from '$lib/server/core.js';

// Serve a file delivered by SendUserFile for display in the conversation. `readUserFile` only
// serves paths that appear in the (session / sub-agent) transcript's own SendUserFile calls
// (allowlist, realpath-guarded) → no arbitrary file read even if the server is bound to 0.0.0.0.
export function GET({ url }) {
  const q = url.searchParams;
  const file = readUserFile(q.get('session') || '', q.get('agent') || '', q.get('path') || '');
  if (!file) return new Response('not found', { status: 404 });
  const disp = file.attachment ? 'attachment' : 'inline';
  return new Response(file.buffer, {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `${disp}; filename="${file.name.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=10',
    },
  });
}
