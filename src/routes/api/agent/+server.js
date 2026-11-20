import path from 'node:path';
import { json } from '@sveltejs/kit';
import { agentTranscriptPath, buildConversation, buildFileChanges, buildVcsChanges, findSessionAny, buildVibeConversation, vibeRead, VIBE_SESSIONS_DIR, statSafe } from '#lib/server/core.js';

// déroulé interne complet d'un sous-agent (sa propre conversation : tools, reads, edits…)
// Provider vibe : le sous-agent est une session unified enfant (childSessionId) → sa conversation
// est rebuildée depuis son journal, ses changements depuis le diff VCS de son projet.
export async function GET({ url }) {
  const q = url.searchParams;
  const parent = findSessionAny(q.get('session'));
  if (parent && parent.provider === 'vibe') {
    const agent = q.get('agent') || '';
    if (!/^[A-Za-z0-9._-]+$/.test(agent)) return json({}, { status: 404 });
    const dir = path.join(VIBE_SESSIONS_DIR, agent);
    // les dossiers child-* n'ont pas forcément de meta.json : le journal suffit
    const { meta } = vibeRead(dir);
    if (!meta && !statSafe(path.join(dir, 'journal'))) return json({}, { status: 404 });
    const messages = buildVibeConversation(dir);
    const cwd = (meta && ((meta.environment && meta.environment.working_directory) || meta.origin_directory)) || parent.project || null;
    const changes = cwd ? (await buildVcsChanges(cwd)).changes : [];
    return json({ agent, provider: 'vibe', messages, changes });
  }
  const fp = agentTranscriptPath(q.get('session'), q.get('agent'));
  if (!fp) return json({}, { status: 404 });
  const messages = buildConversation(fp, true); // tout le fichier est isSidechain
  const changes = buildFileChanges(fp);
  return json({ agent: q.get('agent'), messages, changes });
}
