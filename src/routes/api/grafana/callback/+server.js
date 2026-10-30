import { finishLogin } from '../../../../../server/grafanaGateway.js';

const page = (msg) => new Response(
  `<!doctype html><meta charset="utf-8"><title>hooked</title><body style="font:15px system-ui;padding:40px">${msg}</body>`,
  { headers: { 'content-type': 'text/html; charset=utf-8' } });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function GET({ url }) {
  const q = url.searchParams;
  if (q.get('error')) return page(`Sign-in refused: ${esc(q.get('error_description') || q.get('error'))}`);
  try {
    await finishLogin(q.get('state') || '', q.get('code') || '');
    return page('hooked is connected to mcp-gateway. You can close this tab.<script>window.close()</script>');
  } catch (e) {
    return page(esc(e.message || String(e)));
  }
}
