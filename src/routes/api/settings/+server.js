import { json } from '@sveltejs/kit';
import { readSettings, writeSettings, applyGitSyncSetting, applyRemoteControlSetting, applyPrReviewTagSetting, applyWarmupSetting } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Réglages persistants de hooked (settings.json côté serveur). GET renvoie l'objet complet
// (défauts inclus) ; POST fusionne un patch partiel, valide, persiste et renvoie le résultat.
// GET is a plain read: the settings-driven background loops start with the server
// (src/hooks.server.js) and are re-applied by POST when a setting changes.
export function GET() {
  return json(readSettings());
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  try {
    const settings = writeSettings(body);
    applyGitSyncSetting(settings); // (dé)marre la boucle immédiatement au toggle de autoGitSync
    applyPrReviewTagSetting(settings); // idem pour le tag auto de review PR
    applyRemoteControlSetting(settings); // réconcilie les démons remote-control au changement de liste
    applyWarmupSetting(settings); // le tick relit la config, donc activer la fenêtre 5 h prend effet tout de suite
    return json({ ok: true, settings });
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
