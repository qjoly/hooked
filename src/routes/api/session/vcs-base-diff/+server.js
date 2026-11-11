import { json } from '@sveltejs/kit';
import { scanSessions, buildVcsBaseChanges, worktreeBaseFor } from '$lib/server/core.js';

export async function GET({ url }) {
  const s = scanSessions().find((x) => x.id === url.searchParams.get('id'));
  const cwd = s ? s.project : null;
  const base = cwd ? await worktreeBaseFor(cwd) : null;
  return json(await buildVcsBaseChanges(cwd, base));
}
