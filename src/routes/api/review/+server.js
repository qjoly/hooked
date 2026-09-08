import { json } from '@sveltejs/kit';
import { listThreads, addThread, deleteThread, replyThread, resolveThread, markThreadsSent } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Threads de revue ancrés dans la diff (lentilles Ship / Branch) — la conversation GitHub-style.
// GET ?id= → { threads } ; POST { id, action, … } :
//   comment { thread }        → crée un thread « pending » (batché côté front)
//   delete  { threadId }      → retire un thread (envoyé ou non ; la confirmation est côté UI)
//   reply   { threadId, text, author? } → répond ('user' par défaut ; 'claude' via l'outil MCP)
//   resolve { threadId, resolved }      → clôt / rouvre
//   sent    { ids }           → marque le lot parti vers Claude
export function GET({ url }) {
  const id = url.searchParams.get('id');
  if (!id) return fail(400, 'id required');
  return json({ threads: listThreads(id) });
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.id !== 'string' || !body.id) return fail(400, 'invalid request');
  const { id, action } = body;
  try {
    if (action === 'comment') {
      const thread = addThread(id, body.thread);
      return thread ? json({ ok: true, thread }) : fail(400, 'invalid comment');
    }
    if (action === 'delete') {
      return deleteThread(id, body.threadId) ? json({ ok: true }) : fail(404, 'thread not found');
    }
    if (action === 'reply') {
      const author = body.author === 'claude' ? 'claude' : 'user';
      const thread = replyThread(id, body.threadId, author, body.text);
      return thread ? json({ ok: true, thread }) : fail(404, 'thread not found');
    }
    if (action === 'resolve') {
      const thread = resolveThread(id, body.threadId, body.resolved !== false);
      return thread ? json({ ok: true, thread }) : fail(404, 'thread not found');
    }
    if (action === 'sent') {
      return json({ ok: true, marked: markThreadsSent(id, body.ids) });
    }
    return fail(400, 'unknown action');
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
