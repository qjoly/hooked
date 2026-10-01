import { agentAlive, agentPendingAsk, answerPlan, PLAN_ACTIONS } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Act on a live ExitPlanMode plan from the web UI: approve / approve+auto / keep planning,
// keep-feedback (reject + send the reviewer's bundled comments), and approve-auto-feedback
// (approve + auto-accept, feedback sent as a normal follow-up message — for small, non-structural
// comments that don't warrant another planning round). Resolves the `canUseTool` promise the SDK is
// blocked on — approve = allow (+ pin the target permission mode), keep = deny with the feedback as
// the reason Claude reads.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id) return fail(400, 'id required');
  const action = body.action;
  if (!PLAN_ACTIONS.includes(action)) return fail(400, 'unknown action');
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
  if ((action === 'keep-feedback' || action === 'approve-auto-feedback') && !feedback) return fail(400, 'feedback required');

  if (!agentAlive(id)) return fail(409, 'this session is not driven by hooked (ended, or started outside hooked)');
  const ask = agentPendingAsk(id);
  if (!ask || ask.kind !== 'plan') return fail(409, 'no plan awaiting approval for this session');

  const { err, info } = await toPromise((cb) => answerPlan(id, action, feedback, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
