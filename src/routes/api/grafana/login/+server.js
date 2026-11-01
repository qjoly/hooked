import { json } from '@sveltejs/kit';
import { loginUrl } from '../../../../../server/grafanaGateway.js';

// The callback goes back to where the dashboard is viewed from. adapter-node assumes https when
// ORIGIN is unset, so the browser says which protocol it uses; the host stays the request's own.
export async function GET({ url, request }) {
  try {
    const proto = url.searchParams.get('proto') === 'https' ? 'https' : 'http';
    const host = request.headers.get('host') || url.host;
    return json({ url: await loginUrl(`${proto}://${host}/api/grafana/callback`) });
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
