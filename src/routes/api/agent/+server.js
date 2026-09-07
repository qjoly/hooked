import { json } from '@sveltejs/kit';
import { agentTranscriptPath, buildConversation, buildFileChanges } from '$lib/server/core.js';

// déroulé interne complet d'un sous-agent (sa propre conversation : tools, reads, edits…)
export function GET({ url }) {
  const q = url.searchParams;
  const fp = agentTranscriptPath(q.get('session'), q.get('agent'));
  if (!fp) return json({}, { status: 404 });
  const messages = buildConversation(fp, true); // tout le fichier est isSidechain
  const changes = buildFileChanges(fp);
  return json({ agent: q.get('agent'), messages, changes });
}
