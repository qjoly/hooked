import { json } from '@sveltejs/kit';
import { providerOptions } from '#lib/server/core.js';

// Launch options of a provider (models, thinking levels, modes). Kept for older clients (desktop):
// `?provider=` defaults to the built-in `pi`. New code calls /api/provider-options.
export async function GET({ url }) {
  return json(await providerOptions(url.searchParams.get('provider') || 'pi'));
}
