/*
 * /api/cron routes.
 *   ''       GET lists the tasks; POST { op: 'save', task } | { op: 'delete', id } | { op: 'run', id }.
 *   view     the desktop page as a declarative view (docs/extensions.md, "Declarative view"):
 *            GET ?path= ('' the list, 'edit' / 'edit/<id>' the form, 'runs/<id>' a task's runs);
 *            POST { op, id, form } from its buttons.
 *   preview  GET ?schedule= → the next runs, for the form (computed here, so the app needs no parser).
 */
import { useCronContext, listCronTasks, saveCronTask, deleteCronTask, runCronTask } from './server/cron.js';
import { nextRuns } from './lib/cron.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const firstLine = (s, max) => { const l = String(s || '').split('\n')[0]; return l.length > max ? l.slice(0, max - 1) + '…' : l; };

function preview(schedule) {
  try {
    const runs = nextRuns(schedule, 3);
    return runs.length ? { lines: ['Next: ' + runs.map(stamp).join(' · ')], tone: 'muted' } : { lines: ['This schedule never fires.'], tone: 'warn' };
  } catch (e) {
    return { lines: [e.message], tone: 'error' };
  }
}

function status(t) {
  if (t.starting) return { label: 'starting', tone: 'warn' };
  if (t.lastSession?.waiting) return { label: 'needs you', tone: 'error' };
  if (t.lastSession?.busy) return { label: 'running', tone: 'warn' };
  if (!t.enabled) return { label: 'paused', tone: 'muted' };
  return null;
}

const button = (label, action, extra = {}) => ({ type: 'button', label, action, ...extra });
const post = (op, id, extra = {}) => ({ post: 'view', body: { op, id }, ...extra });

function listView() {
  const tasks = listCronTasks();
  const items = tasks.map((t) => ({
    key: t.id,
    title: t.name,
    subtitle: [t.cwd, t.nextRun && t.enabled ? 'Next ' + stamp(new Date(t.nextRun)) : null].filter(Boolean).join(' · '),
    text: firstLine(t.prompt, 220),
    badges: [{ label: t.schedule, tone: 'muted', mono: true }, status(t)].filter(Boolean),
    actions: [
      button('Run now', post('run', t.id), { icon: 'play' }),
      button(t.enabled ? 'Pause' : 'Resume', post('toggle', t.id)),
      button('Edit', { view: 'edit/' + t.id }),
      ...(t.runs.length ? [button(`${t.runs.length} runs`, { view: 'runs/' + t.id })] : []),
      button('Delete', post('delete', t.id, { confirm: `Delete "${t.name}"?` }), { tone: 'danger' }),
    ],
  }));
  return {
    type: 'column',
    refresh: 10,
    children: [
      { type: 'section', title: 'Cron', actions: [button('New task', { view: 'edit' }, { icon: 'plus', tone: 'primary' })] },
      items.length
        ? { type: 'list', items }
        : { type: 'empty', text: 'No task yet. A task launches a session with its prompt on a schedule.' },
    ],
  };
}

function formView(task) {
  const t = task || { name: '', schedule: '0 9 * * 1-5', cwd: '', prompt: '', enabled: true };
  return {
    type: 'column',
    children: [
      { type: 'section', title: task ? 'Edit task' : 'New task', actions: [button('Cancel', { view: '' })] },
      {
        type: 'form',
        id: 'task',
        fields: [
          { type: 'text', key: 'name', label: 'Name', value: t.name, hint: "Defaults to the prompt's first line" },
          { type: 'text', key: 'schedule', label: 'Schedule (cron, local time)', value: t.schedule, mono: true, preview: 'preview' },
          { type: 'text', key: 'cwd', label: 'Project', value: t.cwd, mono: true },
          { type: 'textarea', key: 'prompt', label: 'Prompt', value: t.prompt },
          { type: 'bool', key: 'enabled', label: 'Enabled', value: t.enabled },
        ],
        submit: button(task ? 'Save' : 'Create task', post('save', task?.id || null), { tone: 'primary' }),
      },
    ],
  };
}

function runsView(task) {
  const items = [...task.runs].reverse().map((r, i) => ({
    key: r.at + i,
    title: stamp(new Date(r.at)) + (r.manual ? ' · manual' : ''),
    subtitle: r.error || (r.skipped ? 'Skipped: ' + r.skipped : ''),
    badges: r.error ? [{ label: 'error', tone: 'error' }] : r.skipped ? [{ label: 'skipped', tone: 'warn' }] : [],
    actions: r.sessionId && !r.error ? [button('Open session', { open: { session: r.sessionId } })] : [],
  }));
  return {
    type: 'column',
    children: [
      { type: 'section', title: `Runs of ${task.name}`, actions: [button('Back', { view: '' })] },
      items.length ? { type: 'list', items } : { type: 'empty', text: 'No run yet.' },
    ],
  };
}

function view(path) {
  const [page, id] = String(path || '').split('/');
  const task = id ? listCronTasks().find((t) => t.id === id) : null;
  if (page === 'edit') return formView(task);
  if (page === 'runs' && task) return runsView(task);
  return listView();
}

// A validation error names the field it is about, so the form can show it there.
const FIELD_OF = [[/schedule/, 'schedule'], [/prompt/, 'prompt'], [/directory/, 'cwd']];
function fieldErrors(message) {
  const hit = FIELD_OF.find(([re]) => re.test(message));
  return hit ? { [hit[1]]: message } : null;
}

async function viewAction(ctx, { op, id, form }) {
  try {
    if (op === 'save') {
      const f = form || {};
      saveCronTask({ ...(id ? { id } : {}), name: f.name, schedule: f.schedule, cwd: f.cwd, prompt: f.prompt, enabled: f.enabled !== false });
      return { flash: 'Saved', view: '' };
    }
    if (op === 'toggle') {
      const t = listCronTasks().find((x) => x.id === id);
      if (!t) return { error: 'task not found' };
      saveCronTask({ id, enabled: !t.enabled });
      return { flash: t.enabled ? 'Paused' : 'Enabled' };
    }
    if (op === 'delete') { deleteCronTask(id); return { flash: 'Deleted', view: '' }; }
    if (op === 'run') {
      const { err } = await ctx.toPromise((cb) => runCronTask(id, { manual: true }, cb));
      return err ? { error: err.message || String(err) } : { flash: 'Started' };
    }
    return { error: 'unknown op' };
  } catch (e) {
    const errors = fieldErrors(e.message || '');
    return errors ? { errors } : { error: e.message || String(e) };
  }
}

export default (ctx) => {
  useCronContext(ctx);
  return {
    '': {
      GET: () => ctx.json({ tasks: listCronTasks() }),
      async POST(request) {
        const body = await ctx.readJson(request);
        if (!body || typeof body !== 'object') return ctx.fail(400, 'invalid request');
        try {
          if (body.op === 'save') return ctx.ok({ task: saveCronTask(body.task) });
          if (body.op === 'delete') { deleteCronTask(body.id); return ctx.ok(); }
          if (body.op === 'run') {
            const { err, info } = await ctx.toPromise((cb) => runCronTask(body.id, { manual: true }, cb));
            if (err) return ctx.fail(err.code === 400 ? 400 : 502, err.message || String(err));
            return ctx.ok(info);
          }
          return ctx.fail(400, 'unknown op');
        } catch (e) {
          return ctx.fail(e.code === 400 ? 400 : 500, e.message || String(e));
        }
      },
    },
    view: {
      GET: (request) => ctx.json(view(new URL(request.url).searchParams.get('path'))),
      async POST(request) {
        return ctx.json(await viewAction(ctx, (await ctx.readJson(request)) || {}));
      },
    },
    preview: {
      GET: (request) => ctx.json(preview(new URL(request.url).searchParams.get('schedule'))),
    },
  };
};
