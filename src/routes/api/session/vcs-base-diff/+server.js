import { json } from '@sveltejs/kit';
import { findSessionAny, buildVcsBaseChanges, worktreeBaseFor } from '#lib/server/core.js';

export async function GET({ url }) {
  const s = findSessionAny(url.searchParams.get('id'));
  const cwd = s ? s.project : null;
  const base = cwd ? await worktreeBaseFor(cwd) : null;
  return json(await buildVcsBaseChanges(cwd, base));
}
