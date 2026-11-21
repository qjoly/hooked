import { json } from '@sveltejs/kit';
import { listSkills, readSkill } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// `?cwd=` (repeatable) adds those projects' skills. `?id=` returns one skill with its body and files.
export function GET({ url }) {
  const cwds = url.searchParams.getAll('cwd');
  const id = url.searchParams.get('id');
  const provider = url.searchParams.get('provider') || undefined; // 'claude' | 'pi' | 'all'
  if (!id) return json(listSkills(cwds, provider));
  const skill = readSkill(id, cwds, provider);
  return skill ? json(skill) : fail(404, 'skill not found');
}
