// Compiled extension pages (server/extensionPages.js). The key in the path changes with the
// content, so a page is cached for good.
import fs from 'node:fs';
import { extensionPageFile } from '#lib/server/core.js';

export function GET({ params }) {
  const file = extensionPageFile(params.path);
  if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}
