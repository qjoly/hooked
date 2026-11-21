import { json } from '@sveltejs/kit';
import { agentTranscriptPath, buildConversation, buildFileChanges, findSessionAny } from '#lib/server/core.js';

// déroulé interne complet d'un sous-agent (sa propre conversation : tools, reads, edits…).
// Provider pi : pas de sous-agents natifs → 404.
export async function GET({ url }) {
  const q = url.searchParams;
  const parent = findSessionAny(q.get('session'));
  if (parent && parent.provider === 'pi') return json({}, { status: 404 });
  const fp = agentTranscriptPath(q.get('session'), q.get('agent'));
  if (!fp) return json({}, { status: 404 });
  const messages = buildConversation(fp, true); // tout le fichier est isSidechain
  const changes = buildFileChanges(fp);
  return json({ agent: q.get('agent'), messages, changes });
}
