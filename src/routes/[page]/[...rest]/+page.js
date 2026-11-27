// The page of a runtime-loaded extension (docs/extensions.md): /<page.key>/<rest>. Static routes
// win, so a core page is never shadowed. No 404 here: the list may not be loaded yet (service
// still booting, request failed), and ExtensionGate renders the page once it names this key.
import { extensionsReady } from '#lib/extensions.svelte.js';

export async function load({ params }) {
  await extensionsReady().catch(() => {});
  return { key: params.page, rest: params.rest || '' };
}
