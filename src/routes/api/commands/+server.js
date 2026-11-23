import { json } from '@sveltejs/kit';
import { scanAllSessions, matchCommands, slashCommands, agentSupportedCommands, rememberSdkCommands, persistedSdkCommands, getProvider, getEngine } from '#lib/server/core.js';

// « / » auto-completion, per provider (explicit `provider` from the New session screen, or the
// session's when `id` is given).
// - claude: .claude/commands + curated / binary-extracted built-ins + the driven session's
//   supportedCommands (the only source for bundled skills).
// - any other engine: the commands its live session declared (ACP available_commands_update) when
//   there is one, else the engine's static list (pi: .pi/prompts + skills + built-ins).
export async function GET({ url }) {
  const q = url.searchParams;
  const id = q.get('id');
  let cwd = q.get('cwd') || null;
  const sess = id ? scanAllSessions().find((x) => x.id === id) : null;
  if (!cwd) cwd = sess && sess.project;
  const provider = q.get('provider') || (sess && sess.provider) || 'claude';
  const pconf = getProvider(provider);
  const engine = pconf ? getEngine(pconf.engine) : null;

  if (engine && engine.id !== 'claude') {
    const live = await agentSupportedCommands(id, provider);
    const list = live ? live.commands : (typeof engine.slashCommands === 'function' ? engine.slashCommands(pconf, cwd) : []);
    return json({ commands: matchCommands(list || [], q.get('q') || '') });
  }

  // Rien de piloté (typiquement l'écran « New session ») : on rejoue la dernière liste connue.
  const live = await agentSupportedCommands(id, 'claude');
  const sdk = live ? rememberSdkCommands(live.commands, live.cwd) : persistedSdkCommands();
  return json({ commands: matchCommands(slashCommands(cwd, sdk), q.get('q') || '') });
}
