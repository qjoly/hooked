import { json } from '@sveltejs/kit';
import { scanSessions, matchCommands, slashCommands, agentSupportedCommands, rememberSdkCommands, persistedSdkCommands } from '$lib/server/core.js';

// auto-complétion « / » : commandes custom (.claude/commands) + built-in (curées, extraites du
// binaire claude, et celles qu'une session pilotée déclare elle-même — seule source pour les
// skills embarqués comme /code-review). cwd explicite (nouvelle session) prioritaire.
export async function GET({ url }) {
  const q = url.searchParams;
  const id = q.get('id');
  let cwd = q.get('cwd') || null;
  if (!cwd) {
    const sess = scanSessions().find((x) => x.id === id);
    cwd = sess && sess.project;
  }
  // Rien de piloté (typiquement l'écran « New session ») : on rejoue la dernière liste connue.
  const live = await agentSupportedCommands(id);
  const sdk = live ? rememberSdkCommands(live.commands, live.cwd) : persistedSdkCommands();
  return json({ commands: matchCommands(slashCommands(cwd, sdk), q.get('q') || '') });
}
