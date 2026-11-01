import { json } from '@sveltejs/kit';
import { listCronTasks, saveCronTask, deleteCronTask, runCronTask } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

export function GET() {
  return json({ tasks: listCronTasks() });
}

// { op: 'save', task } creates or updates, { op: 'delete', id }, { op: 'run', id } runs it now.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  try {
    if (body.op === 'save') return ok({ task: saveCronTask(body.task) });
    if (body.op === 'delete') { deleteCronTask(body.id); return ok(); }
    if (body.op === 'run') {
      const { err, info } = await toPromise((cb) => runCronTask(body.id, { manual: true }, cb));
      if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
      return ok(info);
    }
    return fail(400, 'unknown op');
  } catch (e) {
    return fail(e.code === 400 ? 400 : 500, e.message || String(e));
  }
}
