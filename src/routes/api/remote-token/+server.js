import os from 'node:os';
import { json } from '@sveltejs/kit';
import { remoteToken, rotateRemoteToken, isLoopbackAddress } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Only shown on the hooked machine itself: a remote client holding the token must not read it back.
const localOnly = (getClientAddress) => {
  try { return isLoopbackAddress(getClientAddress()); } catch (_) { return false; }
};

const addresses = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

export function GET({ getClientAddress, url }) {
  if (!localOnly(getClientAddress)) return fail(403, 'only available on the hooked machine');
  return json({ token: remoteToken(), addresses: addresses(), port: Number(url.port) || 80 });
}

export async function POST({ request, getClientAddress }) {
  if (!localOnly(getClientAddress)) return fail(403, 'only available on the hooked machine');
  const body = await readJson(request);
  if (!body?.rotate) return fail(400, 'expected {rotate:true}');
  return json({ ok: true, token: rotateRemoteToken() });
}
