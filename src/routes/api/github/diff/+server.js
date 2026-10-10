import { json } from '@sveltejs/kit';
import { githubDiff } from '../../../../../server/github.js';

export async function GET({ url }) {
  try {
    return json({ files: await githubDiff(url.searchParams.get('url')) });
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
