import { json } from '@sveltejs/kit';
import { scanSessions, matchCommands, slashCommands } from '$lib/server/core.js';

// auto-complétion « / » : commandes custom (.claude/commands) + built-in (curées +
// extraites du binaire claude). cwd explicite (nouvelle session) prioritaire.
export function GET({ url }) {
  const q = url.searchParams;
  let cwd = q.get('cwd') || null;
  if (!cwd) {
    const sess = scanSessions().find((x) => x.id === q.get('id'));
    cwd = sess && sess.project;
  }
  return json({ commands: matchCommands(slashCommands(cwd), q.get('q') || '') });
}
