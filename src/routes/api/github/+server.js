import { json } from '@sveltejs/kit';
import { githubOverview } from '../../../../server/github.js';

export async function GET({ url }) {
  try {
    return json(await githubOverview({ refresh: url.searchParams.has('refresh') }));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
