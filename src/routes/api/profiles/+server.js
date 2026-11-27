import { json } from '@sveltejs/kit';
import { profilesOverview, addAccountProfile, addServerProfile, probeServer, removeProfileForReal } from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// The connection profiles from profiles.json (the implicit `default` first), without their env: no
// token, and no reference to one, ever leaves the server. `errors` lists the entries that were skipped.
export function GET() {
  return json(profilesOverview());
}

// `add-account`: a new profile with a Claude account of its own, its directory managed by hooked.
// The caller then signs it in through /api/account with the profile's id.
// `probe-server`: what a server that is not a profile yet offers (its /v1/models), for the form.
// `add-server`: a new profile for an Anthropic-compatible server (LM Studio…).
// `remove-profile`: an account or a server, refused while a session runs on it.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  switch (body.action) {
    case 'add-account': {
      const r = addAccountProfile(body.label);
      return r.error ? fail(400, r.error) : json({ ok: true, profile: r.profile });
    }
    case 'probe-server':
      return json({ ok: true, ...(await probeServer(body.url, body.token)) });
    case 'add-server': {
      const models = Array.isArray(body.models) ? body.models.filter((m) => typeof m === 'string') : undefined;
      const r = addServerProfile(body.label, { url: body.url, token: body.token, contextWindow: body.contextWindow, models });
      return r.error ? fail(400, r.error) : json({ ok: true, profile: r.profile });
    }
    case 'remove-profile': {
      // Signs the account out, takes the entry out of profiles.json, keeps the account's directory.
      const r = await removeProfileForReal(body.id);
      return r.error ? fail(400, r.error) : json({ ok: true, ...r });
    }
    default:
      return fail(400, 'unknown action');
  }
}
