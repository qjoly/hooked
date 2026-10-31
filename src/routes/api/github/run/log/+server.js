import { json } from '@sveltejs/kit';
import { githubJobLog } from '../../../../../../server/github.js';

export async function GET({ url }) {
  try {
    return json(await githubJobLog(url.searchParams.get('url')));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
