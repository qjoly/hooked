import { json } from '@sveltejs/kit';
import { readSettings, writeSettings, applyGitSyncSetting, applyRemoteControlSetting } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Réglages persistants de hooked (settings.json côté serveur). GET renvoie l'objet complet
// (défauts inclus) ; POST fusionne un patch partiel, valide, persiste et renvoie le résultat.
export function GET() {
  const settings = readSettings();
  // Amorçage de la boucle de synchro git : le front appelle GET /api/settings une fois au
  // démarrage (state.svelte.js:startLive → loadSettings) → la boucle démarre au 1er chargement de
  // page sans nécessiter src/hooks.server.js. Idempotent + gardé sur globalThis.
  applyGitSyncSetting(settings);
  return json(settings);
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  try {
    const settings = writeSettings(body);
    applyGitSyncSetting(settings); // (dé)marre la boucle immédiatement au toggle de autoGitSync
    applyRemoteControlSetting(settings); // réconcilie les démons remote-control au changement de liste
    return json({ ok: true, settings });
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
