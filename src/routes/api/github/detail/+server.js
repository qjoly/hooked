import { json } from '@sveltejs/kit';
import { githubDetail } from '../../../../../server/github.js';

export async function GET({ url }) {
  try {
    return json(await githubDetail(url.searchParams.get('url')));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
