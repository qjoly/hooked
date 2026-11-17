import { json } from '@sveltejs/kit';
import { githubRepoPrs } from '../../../../../server/github.js';

export async function GET({ url }) {
  try {
    return json(await githubRepoPrs(url.searchParams.get('repo'), { refresh: url.searchParams.has('refresh') }));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
