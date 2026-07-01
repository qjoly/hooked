import { paneForSession, liveQuestionForSession, deliverQuestion, deliverReply } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id) return fail(400, 'id required');
  const pane = paneForSession(id);
  if (!pane) return fail(409, 'unknown tmux pane for this session (launched outside tmux, or before this hook?)');

  // Réponse à un AskUserQuestion : on reçoit les INDICES sélectionnés par question et on
  // pilote le TUI au clavier (↓/Espace/Entrée). Bien plus fiable que taper les labels —
  // un multi-select se *navigue*, il ne se *tape* pas.
  const sel = body.selections;
  if (Array.isArray(sel)) {
    if (!sel.length) return fail(400, 'empty selections');
    const selections = sel.map((q) => ({
      multi: !!(q && q.multi),
      indices: Array.isArray(q && q.indices) ? q.indices.filter((n) => Number.isInteger(n) && n >= 0) : [],
    }));
    const { err } = await toPromise((cb) => deliverQuestion(pane, selections, cb));
    if (err) return fail(502, 'tmux send-keys failed : ' + (err.message || err));
    return ok({ pane });
  }

  // `text` : string (texte libre / réponse à choix unique tapée) ou tableau d'intitulés.
  const raw = body.text;
  const text = Array.isArray(raw)
    ? raw.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
    : (typeof raw === 'string' ? raw.trim() : '');
  const empty = Array.isArray(text) ? !text.length : !text;
  if (empty) return fail(400, 'text required');
  // si une question AskUserQuestion est en attente, son TUI réclame une Entrée de
  // confirmation supplémentaire (écran « Submit answers ») pour valider la réponse.
  const isQuestion = !!liveQuestionForSession(id);
  const { err } = await toPromise((cb) => deliverReply(pane, text, isQuestion, cb));
  if (err) return fail(502, 'tmux send-keys failed : ' + (err.message || err));
  return ok({ pane });
}
