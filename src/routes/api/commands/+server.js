import { json } from '@sveltejs/kit';
import { scanAllSessions, matchCommands, slashCommands, vibeSlashCommands, agentSupportedCommands, rememberSdkCommands, persistedSdkCommands } from '#lib/server/core.js';

// auto-complétion « / » : commandes custom + built-in, selon le provider.
// - claude (défaut) : .claude/commands + built-in curées/extraites du binaire + supportedCommands
//   de la session pilotée (seule source pour les skills embarqués).
// - vibe : prompts .vibe/prompts + skills user-invocables + built-in Vibe + availableCommands
//   envoyés par la session ACP. `provider` explicite (écran « New session ») ou déduit de la
//   session quand `id` est donné.
export async function GET({ url }) {
  const q = url.searchParams;
  const id = q.get('id');
  let cwd = q.get('cwd') || null;
  const sess = scanAllSessions().find((x) => x.id === id);
  if (!cwd) cwd = sess && sess.project;
  const provider = q.get('provider') || (sess && sess.provider) || 'claude';

  if (provider === 'vibe') {
    const live = await agentSupportedCommands(id); // branche vibe : st.vibeCommands (ACP)
    return json({ commands: matchCommands(vibeSlashCommands(cwd, live && live.commands), q.get('q') || '') });
  }

  // Rien de piloté (typiquement l'écran « New session ») : on rejoue la dernière liste connue.
  const live = await agentSupportedCommands(id);
  const sdk = live ? rememberSdkCommands(live.commands, live.cwd) : persistedSdkCommands();
  return json({ commands: matchCommands(slashCommands(cwd, sdk), q.get('q') || '') });
}
