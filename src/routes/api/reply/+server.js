import { agentAlive, agentPendingAsk, answerPendingSelection, answerQuestionFreeText, deliverReply } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id) return fail(400, 'id required');
  if (!agentAlive(id)) return fail(409, 'this session is not driven by hooked (ended, or started outside hooked)');

  // Réponse PAR SÉLECTION : on reçoit les indices choisis par question. Aiguillée côté serveur vers
  // l'attente réelle de la session — AskUserQuestion, ou demande de permission d'outil (mêmes
  // options « Allow once / Allow always / Deny » côté UI). Avant la migration hors tmux il fallait
  // piloter le widget au clavier (↓/Entrée/→, ~300 ms entre deux frappes pour qu'ink ne les avale
  // pas) ; maintenant on résout directement la promesse `canUseTool`.
  const sel = body.selections;
  if (Array.isArray(sel)) {
    if (!sel.length) return fail(400, 'empty selections');
    const selections = sel.map((q) => ({
      multi: !!(q && q.multi),
      indices: Array.isArray(q && q.indices) ? q.indices.filter((n) => Number.isInteger(n) && n >= 0) : [],
      // « Other » du composant Question : réponse libre par question (questions uniquement — les
      // attentes plan/permission n'en tiennent pas compte, leur contrat est l'indice).
      other: typeof (q && q.other) === 'string' ? q.other.trim() : '',
    }));
    // Note libre optionnelle : envoyée comme message de suivi après la réponse structurée.
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const { err, info } = await toPromise((cb) => answerPendingSelection(id, selections, note, cb));
    if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
    return ok(info);
  }

  // `text` : string (texte libre / réponse tapée) ou tableau de messages.
  const raw = body.text;
  const text = Array.isArray(raw)
    ? raw.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
    : (typeof raw === 'string' ? raw.trim() : '');
  const empty = Array.isArray(text) ? !text.length : !text;
  if (empty) return fail(400, 'text required');

  // Texte libre alors qu'une question est en attente = l'utilisateur a rejeté les options proposées
  // et tape sa propre réponse : elle part comme valeur de réponse de la question (le champ `answers`
  // du tool accepte n'importe quelle chaîne), pas comme message séparé.
  const ask = agentPendingAsk(id);
  if (ask && ask.kind === 'question') {
    const answer = Array.isArray(text) ? text.join('\n') : text;
    const { err, info } = await toPromise((cb) => answerQuestionFreeText(id, answer, cb));
    if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
    return ok(info);
  }
  const { err, info } = await toPromise((cb) => deliverReply(id, text, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
