import { json } from '@sveltejs/kit';
import { listThreads, addThread, deleteThread, editThread, replyThread, archiveThread, markThreadsSent,
         startReview, addClaudeThread, scanSessions } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Threads de revue ancrés dans la diff (lentilles Ship / Branch) — la conversation GitHub-style.
// GET ?id= → { threads } ; POST { id, action, … } :
//   comment { thread }        → crée un thread « pending » (batché côté front)
//   edit    { threadId, text } → réécrit le message d'ouverture — thread pending uniquement
//   delete  { threadId }      → retire un thread (envoyé ou non ; la confirmation est côté UI)
//   reply   { threadId, text, author? } → répond ('user' par défaut ; 'claude' via l'outil MCP)
//   archive { threadId, archived }      → range / restaure (décision du relecteur : Claude n'a
//                                         plus d'outil MCP pour clore un thread)
//   sent    { ids }           → marque le lot parti vers Claude
//   start   { scope, rev? }   → a review is asked to Claude on that scope (front section key),
//                               whose new side comes from `rev` (none: the file on disk)
//   claude-comment { file, start, end?, text } → Claude opens a thread (MCP add_review_comment)
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
    if (action === 'edit') {
      const thread = editThread(id, body.threadId, body.text);
      return thread ? json({ ok: true, thread }) : fail(400, 'thread not editable');
    }
    if (action === 'delete') {
      return deleteThread(id, body.threadId) ? json({ ok: true }) : fail(404, 'thread not found');
    }
    if (action === 'reply') {
      const author = body.author === 'claude' ? 'claude' : 'user';
      const thread = replyThread(id, body.threadId, author, body.text);
      // Compact, like claude-comment: Claude reads this answer once per reply, and the lens ignores it.
      return thread ? json({ ok: true, thread: { id: thread.id, status: thread.status } }) : fail(404, 'thread not found');
    }
    if (action === 'archive') {
      const thread = archiveThread(id, body.threadId, body.archived !== false);
      return thread ? json({ ok: true, thread }) : fail(404, 'thread not found');
    }
    if (action === 'sent') {
      return json({ ok: true, marked: markThreadsSent(id, body.ids) });
    }
    if (action === 'start') {
      const review = startReview(id, body.scope, body.rev);
      return review ? json({ ok: true, review }) : fail(400, 'invalid scope');
    }
    if (action === 'claude-comment') {
      const cwd = scanSessions().find((x) => x.id === id)?.project || null;
      const { thread, error } = await addClaudeThread(id, body, cwd);
      // Compact on purpose: this answer lands in Claude's context, once per finding.
      return thread ? json({ ok: true, thread: { id: thread.id, file: thread.file, start: thread.start, end: thread.end } }) : fail(400, error);
    }
    return fail(400, 'unknown action');
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
