// Five-field cron expressions (minute hour day-of-month month day-of-week), evaluated in local
// time. Pure, shared by the server scheduler and the UI preview.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

const ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function parseField(src, { name, min, max }) {
  const out = new Set();
  for (const part of src.split(',')) {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid ${name}: "${part}"`);
    let lo = min;
    let hi = max;
    // `5/15` means "from 5, every 15", as in Vixie cron.
    if (m[1] != null) { lo = +m[1]; hi = m[2] != null ? +m[2] : (m[3] ? max : lo); }
    const step = m[3] ? +m[3] : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`${name} out of range: "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

// Throws with a readable message on an invalid expression.
export function parseCron(expr) {
  const src = String(expr || '').trim().toLowerCase();
  const parts = (ALIASES[src] || src).split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error('expected 5 fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  // When both day fields are restricted, a day matches if EITHER does (standard cron).
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function validCron(expr) {
  try { parseCron(expr); return null; } catch (e) { return e.message; }
}

function dayMatches(c, d) {
  const inDom = c.dom.has(d.getDate());
  const inDow = c.dow.has(d.getDay());
  return c.domAny || c.dowAny ? inDom && inDow : inDom || inDow;
}

export function cronMatches(c, d) {
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours())
    && c.month.has(d.getMonth() + 1) && dayMatches(c, d);
}

// First matching minute strictly after `from`, or null (e.g. "0 0 30 2 *" never fires).
export function nextRun(c, from = Date.now()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = d.getTime() + 5 * 366 * 86400000;
  while (d.getTime() < limit) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

export function nextRuns(expr, count = 3, from = Date.now()) {
  const c = parseCron(expr);
  const out = [];
  let t = from;
  while (out.length < count) {
    const d = nextRun(c, t);
    if (!d) break;
    out.push(d);
    t = d.getTime();
  }
  return out;
}
