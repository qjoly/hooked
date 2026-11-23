import { json } from '@sveltejs/kit';
import { providerOptions } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// Launch options of one provider: models (filtered by its `models` patterns), thinking / effort
// levels, modes. Used by the New session screen, the live model switch and Cron.
export async function GET({ url }) {
  const id = url.searchParams.get('provider');
  if (!id) return fail(400, 'provider required');
  return json(await providerOptions(id));
}
