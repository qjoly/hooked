import { readUserFile } from '$lib/server/core.js';

// Serve a file delivered by SendUserFile / show_image / show_video / show_audio for display in the
// conversation. `readUserFile` only serves paths that appear in the (session / sub-agent)
// transcript's own calls (allowlist, realpath-guarded) → no arbitrary file read even if the server
// is bound to 0.0.0.0.
export function GET({ url, request }) {
  const q = url.searchParams;
  const file = readUserFile(q.get('session') || '', q.get('agent') || '', q.get('path') || '');
  if (!file) return new Response('not found', { status: 404 });
  const disp = file.attachment ? 'attachment' : 'inline';
  const headers = {
    'Content-Type': file.contentType,
    'Content-Disposition': `${disp}; filename="${file.name.replace(/["\\\r\n]/g, '_')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=10',
    'Accept-Ranges': 'bytes',
  };
  // Chrome and Safari only seek a <video> served with byte ranges.
  // ponytail: each range request re-reads the whole file (≤ 50 MB), stream from disk if clips grow.
  const size = file.buffer.length;
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(file.buffer.subarray(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(file.buffer, { headers });
}
