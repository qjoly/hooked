// The page of a runtime-loaded extension (docs/extensions.md): /<page.key>/<rest>. Static routes
// win, so a core page is never shadowed; an unknown key is the usual 404.
import { error } from '@sveltejs/kit';
import { extensions, extensionsReady } from '#lib/extensions.svelte.js';

export async function load({ params }) {
  await extensionsReady();
  if (!extensions.list.some((e) => e.page?.key === params.page)) error(404, 'Not found');
  return { key: params.page, rest: params.rest || '' };
}
