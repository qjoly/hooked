import { json } from '@sveltejs/kit';
import { claudeVersionInfo, runUpgrade, restartSession } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Version claude-code de l'installation locale + sessions live qui tournent une version plus
// ancienne (cf. server/claudeUpdate.js). Tout est déclenché par l'utilisateur depuis les Réglages.
// GET  → { install, installed, outdated }.
// POST → { action: 'upgrade' } | { action: 'restart', id }.
export function GET() {
  return json(claudeVersionInfo());
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  const action = body.action;

  if (action === 'upgrade') {
    // runUpgrade ne lance JAMAIS sudo : si le préfixe n'est pas inscriptible, il renvoie
    // { ok:false, needsSudo, warning, cmd } sans rien exécuter → 200 pour que l'UI affiche l'avertissement.
    const { info } = await toPromise((cb) => runUpgrade(cb));
    return json(info || { ok: false, warning: 'upgrade failed' });
  }

  if (action === 'restart') {
    const id = body.id;
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) return fail(400, 'invalid session id');
    const opts = { model: body.model || null, effort: body.effort || null };
    const { err, info } = await toPromise((cb) => restartSession(id, opts, cb));
    if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
    return ok(info);
  }

  return fail(400, 'unknown action');
}
