import { paneForSession, livePlanForSession, deliverPlanChoice } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

const ACTIONS = ['approve', 'approve-auto', 'keep', 'keep-feedback'];

// Act on a live ExitPlanMode plan from the web UI: approve / approve+auto / keep planning, and
// keep-feedback (reject + send the reviewer's bundled comments). Drives the TUI approval menu.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id) return fail(400, 'id required');
  const action = body.action;
  if (!ACTIONS.includes(action)) return fail(400, 'unknown action');
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
  if (action === 'keep-feedback' && !feedback) return fail(400, 'feedback required');

  const pane = paneForSession(id);
  if (!pane) return fail(409, 'unknown tmux pane for this session (launched outside tmux, or before this hook?)');
  // Gate on a live plan so we never drive the menu for a stale/already-resolved card.
  if (!livePlanForSession(id)) return fail(409, 'no plan awaiting approval for this session');

  const { err } = await toPromise((cb) => deliverPlanChoice(pane, action, feedback, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok({ pane });
}
