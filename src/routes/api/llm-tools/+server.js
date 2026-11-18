import { json } from '@sveltejs/kit';
import { agentToolCatalog } from '#lib/server/core.js';

// Tool catalog of a driven session, as sent to the model (Settings → Claude Code → "Tools sent to the model").
export async function GET({ url }) {
  return json(await agentToolCatalog(url.searchParams.get('id') || null));
}
