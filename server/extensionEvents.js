/*
 * Core events extensions can listen to (docs/extensions.md): `session:start`, `turn:end`,
 * `session:end`, `session:archived`, `settings:changed`. The core emits and never waits: a listener
 * runs on a later tick, so an extension can neither slow a turn nor block an archive, and one that
 * throws only logs. Payloads carry ids, never conversation content.
 *
 * Imports nothing, so agent.js and sessionMeta.js can emit without loading the extension registry.
 */
const EVENTS = ['session:start', 'turn:end', 'session:end', 'session:archived', 'settings:changed'];

// Pinned on globalThis: Vite re-executing this file in `npm run live` must keep the subscriptions.
const SUBS = (globalThis[Symbol.for('hooked.extensionEvents')] ??= new Map());

// `on` is the lifecycle's `on` map. Replaces any previous subscription of the same extension.
function subscribeExtension(id, on) {
  const handlers = Object.fromEntries(Object.entries(on || {}).filter(([k, fn]) => EVENTS.includes(k) && typeof fn === 'function'));
  if (Object.keys(handlers).length) SUBS.set(id, handlers);
  else SUBS.delete(id);
}

function unsubscribeExtension(id) {
  SUBS.delete(id);
}

function emitExtensionEvent(name, payload) {
  for (const [id, handlers] of SUBS) {
    const fn = handlers[name];
    if (!fn) continue;
    setImmediate(async () => {
      try { await fn(payload); } catch (e) { console.error(`[hooked] extension ${id}: ${name} listener: ${e?.message || e}`); }
    });
  }
}

export { EVENTS as EXTENSION_EVENTS, subscribeExtension, unsubscribeExtension, emitExtensionEvent };
