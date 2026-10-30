import { json } from '@sveltejs/kit';
import { runQuery } from '../../../../../server/grafanaGateway.js';

export async function POST({ request }) {
  try {
    return json({ data: await runQuery(await request.json()) });
  } catch (e) {
    return json({ error: e.message || String(e), login: !!e.login }, { status: e.login ? 401 : 502 });
  }
}
