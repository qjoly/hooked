// Helpers de réponse pour les endpoints /api/*. Conserve la forme de l'ancien serveur :
// les POST renvoient { ok: true|false, ... } (le front lit `d.ok`), avec le bon statut HTTP.
import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';

export const ok = (extra = {}) => json({ ok: true, ...extra });
export const fail = (status, message) => json({ ok: false, error: message }, { status });

// Adapte une fonction métier à callback (cb(err, info)) en promesse { err, info }.
export const toPromise = (fn) => new Promise((resolve) => fn((err, info) => resolve({ err, info })));

// Lit le corps JSON d'une requête ; renvoie null si invalide.
export const readJson = (request) => request.json().catch(() => null);

// JSON response with a strong validator. The dashboard polls the same URLs every few seconds and
// most of the time nothing changed: when `If-None-Match` matches, we answer 304 with no body and
// the browser reuses the copy it already has. `etagOf` lets the caller hash only the stable part of
// the payload (a timestamp that changes on every call would defeat the validator).
export function jsonWithEtag(request, data, etagOf = data) {
  const etag = '"' + createHash('sha1').update(JSON.stringify(etagOf)).digest('base64url') + '"';
  const headers = { ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  const inm = request.headers.get('if-none-match');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(JSON.stringify(data), { headers: { ...headers, 'Content-Type': 'application/json' } });
}
