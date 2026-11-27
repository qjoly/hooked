// Pure helpers about extensions (docs/extensions.md), shared by the server and the dashboard.
// The list itself is not here: it comes from GET /api/extensions, at runtime.

export const EXTENSION_ID = /^[a-z][a-z0-9-]{1,31}$/;

// settings.extensions decides; until it names the extension, the Android-era `modules` key does
// (settings written before extensions existed); else the manifest's `default`.
export function extensionOn(settings, id, fallback = true) {
  const own = settings?.extensions?.[id];
  if (typeof own === 'boolean') return own;
  const legacy = settings?.modules?.[id];
  if (typeof legacy === 'boolean') return legacy;
  return fallback !== false;
}

// settings.extensions from anything: booleans keyed by valid ids. Unknown ids are kept, since an
// extension can be switched off before it is installed, or while it is being updated.
export function sanitizeExtensions(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(Object.entries(o).filter(([id, v]) => EXTENSION_ID.test(id) && typeof v === 'boolean'));
}

export function extensionOfPage(list, page) {
  return (list || []).find((e) => e.page?.key === page) || null;
}
