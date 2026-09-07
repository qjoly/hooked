// Helpers de réponse pour les endpoints /api/*. Conserve la forme de l'ancien serveur :
// les POST renvoient { ok: true|false, ... } (le front lit `d.ok`), avec le bon statut HTTP.
import { json } from '@sveltejs/kit';

export const ok = (extra = {}) => json({ ok: true, ...extra });
export const fail = (status, message) => json({ ok: false, error: message }, { status });

// Adapte une fonction métier à callback (cb(err, info)) en promesse { err, info }.
export const toPromise = (fn) => new Promise((resolve) => fn((err, info) => resolve({ err, info })));

// Lit le corps JSON d'une requête ; renvoie null si invalide.
export const readJson = (request) => request.json().catch(() => null);
