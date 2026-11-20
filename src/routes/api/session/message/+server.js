import { json } from '@sveltejs/kit';
import { findSessionAny, agentTranscriptPath, readMessageText, vibeMessageText } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// Texte COMPLET d'un message user, chargé à la demande quand la bulle a été marqué `truncated`
// (« Show more » dans le fil). `uuid` est le point de coupe déjà exposé par la conversation
// (forkUuid) : on ne sert donc jamais qu'une ligne du transcript de CETTE session, ou de celui
// d'un de ses sous-agents quand `agent` est fourni.
// Provider vibe : `uuid` = id de l'entry message du journal → texte via vibeMessageText.
export function GET({ url }) {
  const id = url.searchParams.get('id');
  const uuid = url.searchParams.get('uuid');
  const agent = url.searchParams.get('agent');
  if (!id || !uuid) return fail(400, 'id and uuid required');
  const s = findSessionAny(id);
  if (!s || !s.file) return fail(404, 'session not found');
  if (s.provider === 'vibe') {
    const text = vibeMessageText(s.dir, uuid, agent);
    if (text == null) return fail(404, 'message not found');
    return json({ text });
  }
  const fp = agent ? agentTranscriptPath(id, agent) : s.file;
  const text = fp ? readMessageText(fp, uuid) : null;
  if (text == null) return fail(404, 'message not found');
  return json({ text });
}
