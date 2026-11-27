// The API handlers of a legacy extension (docs/extensions.md) answer as the extension dispatcher
// does while the extension is switched off: 404 `extension_off`.
import { extensionEnabled, extensionLabel } from '#server/extensions.js';

export function gated(id, handler) {
  return (event) => (extensionEnabled(id)
    ? handler(event)
    : Response.json({ ok: false, error: `the ${extensionLabel(id)} extension is off (Settings → Extensions)`, code: 'extension_off' }, { status: 404 }));
}
