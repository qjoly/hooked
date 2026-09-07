import { resizeTerminal } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Aligne le PTY sur la place réellement dispo dans la vue web. Sans ça le shell garde une largeur
// figée et tout ce qui met en colonnes (`ls`, `git log --graph`, un TUI) est mal coupé.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const { err, info } = await toPromise((cb) => resizeTerminal(body.id, body.cols, body.rows, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
