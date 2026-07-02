import { json } from '@sveltejs/kit';
import { ghView } from '../../../../server/ghMeta.js';

export async function GET({ url }) {
  const target = url.searchParams.get('url');
  const meta = await ghView(target);
  return json(meta || { available: false });
}
