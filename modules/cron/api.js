/*
 * /api/cron (src/routes/api/cron/+server.js re-exports these). GET lists the tasks; POST takes
 * { op: 'save', task } (create or update), { op: 'delete', id }, or { op: 'run', id } (run it now).
 */
import { json } from '@sveltejs/kit';
import { gated } from '#lib/server/modules.js';
import { ok, fail, toPromise, readJson } from '#lib/server/respond.js';
import { listCronTasks, saveCronTask, deleteCronTask, runCronTask } from './server/cron.js';

export const GET = gated('cron', () => json({ tasks: listCronTasks() }));

export const POST = gated('cron', async ({ request }) => {
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
});
