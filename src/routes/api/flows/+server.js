import { json } from '@sveltejs/kit';
import {
  listFlowTemplates, saveFlowTemplate, deleteFlowTemplate, listFlowRuns, getFlowRun, startFlowRun,
  reportFlowStage, stopFlowRun, finishFlowRun, continueFlowRun, rerunFlowStage, markFlowStageDone, deleteFlowRun,
} from '#lib/server/core.js';
import { ok, fail, toPromise, readJson } from '#lib/server/respond.js';

export function GET({ url }) {
  const id = url.searchParams.get('run');
  if (id) {
    const run = getFlowRun(id);
    return run ? json({ run }) : json({ error: 'run not found' }, { status: 404 });
  }
  return json({ templates: listFlowTemplates(), runs: listFlowRuns() });
}

// Ops: saveTemplate { template }, deleteTemplate { id }, start { templateId | flow, task, cwd, name?,
// worktree?, base? }, report { launchKey, summary, verdict? } (MCP flow_report), stop / finish /
// continue / delete { id }, rerun { id, stage, note?, loop? }, markDone { id, stage, summary?, verdict? }.
export async function POST({ request }) {
  const b = await readJson(request);
  if (!b || typeof b !== 'object') return fail(400, 'invalid request');
  try {
    switch (b.op) {
      case 'saveTemplate': return ok({ template: saveFlowTemplate(b.template) });
      case 'deleteTemplate': deleteFlowTemplate(b.id); return ok();
      case 'start': {
        const { err, info } = await toPromise((cb) => startFlowRun(b, cb));
        if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
        return ok(info);
      }
      case 'report': return ok(reportFlowStage(b));
      case 'stop': return ok({ run: stopFlowRun(b.id) });
      case 'finish': return ok({ run: finishFlowRun(b.id) });
      case 'continue': return ok({ run: continueFlowRun(b.id) });
      case 'rerun': return ok({ run: rerunFlowStage(b.id, b.stage, { note: b.note, loop: b.loop === true }) });
      case 'markDone': return ok({ run: markFlowStageDone(b.id, b.stage, { summary: b.summary, verdict: b.verdict }) });
      case 'delete': deleteFlowRun(b.id); return ok();
      default: return fail(400, 'unknown op');
    }
  } catch (e) {
    return fail(e.code === 400 ? 400 : 500, e.message || String(e));
  }
}
