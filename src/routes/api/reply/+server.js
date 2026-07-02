import { paneForSession, liveQuestionForSession, deliverQuestionWithNote, deliverQuestionFreeText, deliverReply } from '$lib/server/core.js';
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
    // optional annotation notes: sent as a follow-up message after the options are checked+submitted
    // (free text alone doesn't check the boxes, so the structured answer must go through the nav).
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const { err } = await toPromise((cb) => deliverQuestionWithNote(pane, selections, note, cb));
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
  // Free text while an AskUserQuestion is pending = the user rejected the offered options and typed
  // their own answer. The selection widget swallows typed characters, so we can't type into it:
  // deliverQuestionFreeText sends Escape to dismiss the widget, then delivers the text as a normal
  // reply. Free text is a single message (join a legacy array of labels on newlines).
  if (liveQuestionForSession(id)) {
    const answer = Array.isArray(text) ? text.join('\n') : text;
    const { err } = await toPromise((cb) => deliverQuestionFreeText(pane, answer, cb));
    if (err) return fail(502, 'tmux send-keys failed : ' + (err.message || err));
    return ok({ pane });
  }
  const { err } = await toPromise((cb) => deliverReply(pane, text, false, cb));
  if (err) return fail(502, 'tmux send-keys failed : ' + (err.message || err));
  return ok({ pane });
}
