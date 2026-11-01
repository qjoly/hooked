/*
 * Cron tasks: a prompt launched as a new driven session on a schedule. Stored in cron-tasks.json
 * of HOOKED_DIR. A task keeps at most one live session: a run closes the previous one if it sits
 * idle, and is skipped if it is still working or waiting on the user. Runs missed while hooked
 * was down are not caught up, as with cron.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOOKED_DIR, LAUNCH_PERMISSION_MODES } from './config.js';
import { launchSession, killSession, agentAlive, agentBusy, agentPendingAsk, err400 } from './agent.js';
import { readTags, setTags } from './tags.js';
import { parseCron, cronMatches, nextRun } from '../src/lib/cron.js';

const CRON_FILE = path.join(HOOKED_DIR, 'cron-tasks.json');
const MAX_RUNS = 20;
const CRON_TAG = 'cron';
const STARTED = Symbol.for('hooked.cron.started');
const INFLIGHT = (globalThis[Symbol.for('hooked.cron.inflight')] ??= new Set());

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
    permissionMode: LAUNCH_PERMISSION_MODES.includes(o.permissionMode) ? o.permissionMode : 'default',
    ephemeral: o.ephemeral === true,
    enabled: o.enabled !== false,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
    runs: Array.isArray(o.runs) ? o.runs.filter((r) => r && typeof r.at === 'string').slice(-MAX_RUNS) : [],
  };
}

function readCronTasks() {
  try {
    const list = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
    return Array.isArray(list) ? list.map(cleanTask).filter((t) => t.id) : [];
  } catch (_) {
    return [];
  }
}

function writeCronTasks(list) {
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  fs.writeFileSync(CRON_FILE, JSON.stringify(list, null, 2) + '\n');
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
    const alive = sid && agentAlive(sid);
    return {
      ...t,
      nextRun: next,
      starting: INFLIGHT.has(t.id),
      lastSession: sid ? { id: sid, alive: !!alive, busy: alive ? agentBusy(sid) === true : false, waiting: alive ? !!agentPendingAsk(sid) : false } : null,
    };
  });
}

// Creates (no id) or updates a task. Runs history is kept from the stored task, never the payload.
function saveCronTask(raw) {
  const t = cleanTask(raw);
  if (!t.schedule) throw err400('schedule required');
  try { parseCron(t.schedule); } catch (e) { throw err400('invalid schedule: ' + e.message); }
  if (!t.prompt) throw err400('prompt required');
  if (!t.cwd) throw err400('project directory required');
  const st = fs.statSync(t.cwd, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw err400('not a directory: ' + t.cwd);
  if (!t.name) t.name = t.prompt.split('\n')[0].slice(0, 60);

  const list = readCronTasks();
  const i = t.id ? list.findIndex((x) => x.id === t.id) : -1;
  if (t.id && i < 0) throw err400('task not found');
  if (i >= 0) {
    list[i] = { ...t, createdAt: list[i].createdAt, runs: list[i].runs };
  } else {
    t.id = crypto.randomBytes(5).toString('hex');
    t.runs = [];
    list.push(t);
  }
  writeCronTasks(list);
  return i >= 0 ? list[i] : t;
}

function deleteCronTask(id) {
  const list = readCronTasks();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) throw err400('task not found');
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
  if (!task) return cb(err400('task not found'));
  if (INFLIGHT.has(id)) return cb(err400('this task is already starting'));
  const base = { at: at.toISOString(), ...(manual ? { manual: true } : {}) };

  const prev = lastSessionId(task);
  if (prev && agentAlive(prev)) {
    if (agentBusy(prev) || agentPendingAsk(prev)) {
      const reason = agentPendingAsk(prev) ? 'previous run is waiting on you' : 'previous run is still working';
      recordRun(id, { ...base, skipped: reason, sessionId: prev });
      return cb(err400(reason));
    }
    killSession(prev, () => {});
  }

  INFLIGHT.add(id);
  launchSession({ cwd: task.cwd, prompt: task.prompt, model: task.model, effort: task.effort, permissionMode: task.permissionMode, ephemeral: task.ephemeral }, (e, info) => {
    INFLIGHT.delete(id);
    if (e) {
      recordRun(id, { ...base, error: e.message || String(e) });
      return cb(e);
    }
    recordRun(id, { ...base, sessionId: info.sessionId });
    try { setTags(info.sessionId, [...(readTags()[info.sessionId] || []), CRON_TAG]); } catch (_) {}
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

function startCronScheduler() {
  if (globalThis[STARTED]) return;
  globalThis[STARTED] = true;
  const arm = () => {
    // Wake just past the next minute boundary so the tick reads the minute it is meant for.
    const t = setTimeout(() => { cronTick(new Date()); arm(); }, 60000 - (Date.now() % 60000) + 50);
    t.unref?.();
  };
  arm();
}

export { CRON_FILE, readCronTasks, listCronTasks, saveCronTask, deleteCronTask, runCronTask, cronTick, startCronScheduler };
