import { json } from '@sveltejs/kit';
import { readSettings, writeSettings, applyGitSyncSetting, applyRemoteControlSetting, applyPrReviewTagSetting, applyWarmupSetting } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Réglages persistants de hooked (settings.json côté serveur). GET renvoie l'objet complet
// (défauts inclus) ; POST fusionne un patch partiel, valide, persiste et renvoie le résultat.
export function GET() {
  const settings = readSettings();
  // Amorçage des boucles de fond (synchro git, tag auto de review PR) : le front appelle GET
  // /api/settings une fois au démarrage (state.svelte.js:startLive → loadSettings) → les boucles
  // démarrent au 1er chargement de page sans nécessiter src/hooks.server.js. Idempotent + gardé
  // sur globalThis.
  applyGitSyncSetting(settings);
  applyPrReviewTagSetting(settings);
  applyWarmupSetting(settings); // idem pour la gestion de fenêtre 5 h (no-op tant qu'elle est off)
  return json(settings);
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
