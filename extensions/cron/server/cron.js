/*
 * Cron tasks: a prompt launched as a new driven session on a schedule. Stored in cron-tasks.json
 * of HOOKED_DIR. A task keeps at most one live session: a run closes the previous one if it sits
 * idle, and is skipped if it is still working or waiting on the user. Runs missed while hooked
 * was down are not caught up, as with cron.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCron, cronMatches, nextRun } from '../lib/cron.js';

const MAX_RUNS = 20;
const CRON_TAG = 'cron';
const INFLIGHT = new Set();
let timer = null;

// The core's facade (server/ext/context.js), handed over by the lifecycle and by api.js.
let ctx = null;
function useCronContext(c) { ctx = c; }
const cronFile = () => path.join(ctx.hookedDir, 'cron-tasks.json');

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanTask(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof o.id === 'string' && /^[a-z0-9]{1,16}$/.test(o.id) ? o.id : null,
    name: str(o.name, 80),
    schedule: str(o.schedule, 120),
    cwd: str(o.cwd, 1024),
    prompt: typeof o.prompt === 'string' ? o.prompt.trim() : '',
    model: str(o.model, 80) || null,
    effort: str(o.effort, 40) || null,
    permissionMode: ctx.LAUNCH_PERMISSION_MODES.includes(o.permissionMode) ? o.permissionMode : 'default',
    // launch provider: any provider id (validated at launch time against the registry). None: each
    // run takes the settings' default provider, so a task keeps working when a provider is switched
    // off (the claude one, once Claude runs through pi).
    provider: typeof o.provider === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(o.provider) ? o.provider : null,
    ephemeral: o.ephemeral === true,
    enabled: o.enabled !== false,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
    runs: Array.isArray(o.runs) ? o.runs.filter((r) => r && typeof r.at === 'string').slice(-MAX_RUNS) : [],
  };
}

function readCronTasks() {
  try {
    const list = JSON.parse(fs.readFileSync(cronFile(), 'utf8'));
    return Array.isArray(list) ? list.map(cleanTask).filter((t) => t.id) : [];
  } catch (_) {
    return [];
  }
}

function writeCronTasks(list) {
  fs.mkdirSync(ctx.hookedDir, { recursive: true });
  fs.writeFileSync(cronFile(), JSON.stringify(list, null, 2) + '\n');
}

function lastSessionId(task) {
  for (let i = task.runs.length - 1; i >= 0; i--) if (task.runs[i].sessionId) return task.runs[i].sessionId;
  return null;
}

// Tasks as the UI shows them: next occurrence and the state of the last run's session.
function listCronTasks(now = Date.now()) {
  return readCronTasks().map((t) => {
    let next = null;
    try { next = t.enabled ? nextRun(parseCron(t.schedule), now)?.toISOString() || null : null; } catch (_) {}
    const sid = lastSessionId(t);
    const alive = sid && ctx.agentAlive(sid);
    return {
      ...t,
      nextRun: next,
      starting: INFLIGHT.has(t.id),
      lastSession: sid ? { id: sid, alive: !!alive, busy: alive ? ctx.agentBusy(sid) === true : false, waiting: alive ? !!ctx.agentPendingAsk(sid) : false } : null,
    };
  });
}

// Creates (no id) or updates a task. An update only changes the fields it carries, and the runs
// history always comes from the stored task.
function saveCronTask(raw) {
  const patch = raw && typeof raw === 'object' ? raw : {};
  const list = readCronTasks();
  const i = patch.id ? list.findIndex((x) => x.id === patch.id) : -1;
  if (patch.id && i < 0) throw ctx.err400('task not found');
  const t = cleanTask(i >= 0
    ? { ...list[i], ...patch, createdAt: list[i].createdAt, runs: list[i].runs }
    : { ...patch, id: null, createdAt: null, runs: [] });
  if (!t.schedule) throw ctx.err400('schedule required');
  try { parseCron(t.schedule); } catch (e) { throw ctx.err400('invalid schedule: ' + e.message); }
  if (!t.prompt) throw ctx.err400('prompt required');
  if (!t.cwd) throw ctx.err400('project directory required');
  const st = fs.statSync(t.cwd, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw ctx.err400('not a directory: ' + t.cwd);
  if (!t.name) t.name = t.prompt.split('\n')[0].slice(0, 60);

  if (i >= 0) list[i] = t;
  else {
    t.id = crypto.randomBytes(5).toString('hex');
    list.push(t);
  }
  writeCronTasks(list);
  return t;
}

function deleteCronTask(id) {
  const list = readCronTasks();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) throw ctx.err400('task not found');
  writeCronTasks(next);
}

function recordRun(id, run) {
  const list = readCronTasks();
  const t = list.find((x) => x.id === id);
  if (!t) return;
  t.runs = [...t.runs, run].slice(-MAX_RUNS);
  writeCronTasks(list);
}

function runCronTask(id, { manual = false, at = new Date() } = {}, cb = () => {}) {
  const task = readCronTasks().find((t) => t.id === id);
  if (!task) return cb(ctx.err400('task not found'));
  if (INFLIGHT.has(id)) return cb(ctx.err400('this task is already starting'));
  const base = { at: at.toISOString(), ...(manual ? { manual: true } : {}) };

  const prev = lastSessionId(task);
  if (prev && ctx.agentAlive(prev)) {
    if (ctx.agentBusy(prev) || ctx.agentPendingAsk(prev)) {
      const reason = ctx.agentPendingAsk(prev) ? 'previous run is waiting on you' : 'previous run is still working';
      recordRun(id, { ...base, skipped: reason, sessionId: prev });
      return cb(ctx.err400(reason));
    }
    ctx.killSession(prev, () => {});
  }

  INFLIGHT.add(id);
  ctx.launchSession({ cwd: task.cwd, prompt: task.prompt, model: task.model, effort: task.effort, permissionMode: task.permissionMode, ephemeral: task.ephemeral, provider: task.provider || undefined }, (e, info) => {
    INFLIGHT.delete(id);
    if (e) {
      recordRun(id, { ...base, error: e.message || String(e) });
      return cb(e);
    }
    recordRun(id, { ...base, sessionId: info.sessionId });
    try { ctx.setTags(info.sessionId, [...(ctx.readTags()[info.sessionId] || []), CRON_TAG]); } catch (_) {}
    cb(null, info);
  });
}

function cronTick(now = new Date()) {
  for (const t of readCronTasks()) {
    if (!t.enabled) continue;
    let c;
    try { c = parseCron(t.schedule); } catch (_) { continue; }
    if (cronMatches(c, now)) runCronTask(t.id, { at: now });
  }
}

// Wakes just past each minute boundary so the tick reads the minute it is meant for. stop() must
// clear it: a hot update starts the new version's scheduler right after.
function startCronScheduler() {
  if (timer) return;
  const arm = () => {
    timer = setTimeout(() => { cronTick(new Date()); arm(); }, 60000 - (Date.now() % 60000) + 50);
    timer.unref?.();
  };
  arm();
}

function stopCronScheduler() {
  clearTimeout(timer);
  timer = null;
}

export { useCronContext, readCronTasks, listCronTasks, saveCronTask, deleteCronTask, runCronTask, cronTick, startCronScheduler, stopCronScheduler };
