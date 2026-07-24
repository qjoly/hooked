#!/usr/bin/env node
'use strict';

// hooked new-session form — a zero-dependency terminal form meant to run inside a tmux
// display-popup (launched with `n` from the sidebar). Collects the fields POST /api/launch
// needs and submits them; on success the popup closes and the sidebar picks up the new
// session over SSE.
//
//   argv[2]                default folder (cwd) to pre-fill — the sidebar passes the
//                          highlighted session's project.
//   HOOKED_PORT / HOOKED_MCP_URL   how to reach the hooked server (same as the sidebar).

const http = require('http');
const os = require('os');

const HOME = os.homedir();
const PORT = process.env.HOOKED_PORT || '4123';
const BASE = (process.env.HOOKED_MCP_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const DEFAULT_DIR = process.argv[2] || '';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', rev: '\x1b[7m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};

const FALLBACK_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];

const form = {
  fields: [
    { key: 'folder', label: 'Folder', type: 'text', value: DEFAULT_DIR },
    { key: 'prompt', label: 'First prompt', type: 'text', value: '' },
    { key: 'model', label: 'Model', type: 'select', value: 'default', options: ['default', ...FALLBACK_MODELS] },
    { key: 'effort', label: 'Effort', type: 'select', value: 'default', options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { key: 'worktree', label: 'Git worktree', type: 'bool', value: false },
    { key: 'submit', label: 'Create session', type: 'button' },
  ],
  idx: 0,
  status: '',
  busy: false,
};

const field = (k) => form.fields.find((f) => f.key === k);
const getVal = (k) => field(k).value;

function setOptions(key, opts) {
  const f = field(key);
  if (!opts.length) return;
  f.options = opts;
  if (!opts.includes(f.value)) f.value = opts[0];
}
function preselect(key, val) {
  if (!val) return;
  const f = field(key);
  if (!f.options.includes(val)) f.options = [f.options[0], val, ...f.options.slice(1)];
  f.value = val;
}

// defensively flatten whatever /api/capabilities returns for models (groups, ids, strings…).
function flattenModels(m) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (typeof x === 'string') { out.push(x); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      if (x.id) out.push(x.id);
      if (x.model) out.push(x.model);
      if (x.value) out.push(x.value);
      walk(x.models); walk(x.items); walk(x.children);
    }
  };
  walk(m);
  return [...new Set(out)];
}

function getJSON(path, cb) {
  const req = http.get(BASE + path, { timeout: 3000 }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => { try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
  });
  req.on('error', cb);
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
}

function postJSON(path, body, cb) {
  const data = Buffer.from(JSON.stringify(body));
  const u = new URL(BASE + path);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 8000,
  }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) return cb(null, b);
      let msg = `HTTP ${res.statusCode}`;
      try { const j = JSON.parse(b); msg = j.error || j.message || msg; } catch (_) { if (b) msg = b.slice(0, 80); }
      cb(new Error(msg));
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.end(data);
}

function expand(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return HOME + p.slice(1);
  return p;
}

function render() {
  const W = process.stdout.columns || 60;
  const H = process.stdout.rows || 20;
  const o = ['\x1b[H\x1b[2J'];
  o.push(`\x1b[1;2H${C.bold}${C.cyan}New hooked session${C.reset}`);
  let row = 3;
  for (let i = 0; i < form.fields.length; i++) {
    const f = form.fields[i];
    const sel = i === form.idx;
    if (f.type === 'button') {
      row += 1;
      const btn = ` ${f.label} `;
      o.push(`\x1b[${row};2H` + (sel ? C.rev + btn + C.reset : `${C.dim}[${btn}]${C.reset}`));
      row += 1;
      continue;
    }
    const mark = sel ? `${C.cyan}▸${C.reset}` : ' ';
    let val;
    if (f.type === 'text') {
      const v = String(f.value || '').slice(-(W - 22));
      val = sel ? `${C.rev} ${v || ' '} ${C.reset}` : (v ? v : `${C.dim}(empty)${C.reset}`);
    } else if (f.type === 'select') {
      val = `${C.dim}‹${C.reset} ${sel ? C.rev + ' ' : ''}${f.value}${sel ? ' ' + C.reset : ''} ${C.dim}›${C.reset}`;
    } else { // bool
      val = f.value ? `${C.green}[x]${C.reset} yes` : `${C.dim}[ ] no${C.reset}`;
    }
    o.push(`\x1b[${row};2H${mark} ${f.label.padEnd(13)} ${val}`);
    row += 1;
  }
  o.push(`\x1b[${H - 1};2H${C.dim}↑/↓ field · ←/→ change · space toggle · type to edit${C.reset}`);
  const help2 = `${C.dim}↵ create · esc cancel${C.reset}`;
  o.push(`\x1b[${H};2H` + (form.status || help2));
  process.stdout.write(o.join(''));
}

function moveField(delta) {
  const n = form.fields.length;
  form.idx = (form.idx + delta + n) % n;
  render();
}
function changeField(delta) {
  const f = form.fields[form.idx];
  if (f.type === 'select') {
    const i = f.options.indexOf(f.value);
    f.value = f.options[(i + delta + f.options.length) % f.options.length];
    render();
  } else if (f.type === 'bool') {
    f.value = !f.value;
    render();
  }
}
function backspace() {
  const f = form.fields[form.idx];
  if (f.type === 'text' && f.value) { f.value = f.value.slice(0, -1); render(); }
}

function submit() {
  const folder = expand(String(getVal('folder')).trim());
  if (!folder) { form.status = `${C.red} folder is required${C.reset}`; return render(); }
  const body = { cwd: folder };
  const p = String(getVal('prompt')).trim(); if (p) body.prompt = p;
  const m = getVal('model'); if (m && m !== 'default') body.model = m;
  const e = getVal('effort'); if (e && e !== 'default') body.effort = e;
  if (getVal('worktree')) body.worktree = true;
  form.busy = true; form.status = `${C.yellow} launching…${C.reset}`; render();
  postJSON('/api/launch', body, (err) => {
    form.busy = false;
    if (err) { form.status = `${C.red} ${err.message || err}${C.reset}`; return render(); }
    cleanup();
    process.exit(0);
  });
}

function cleanup() {
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.stdout.write('\x1b[?1049l\x1b[?25h');
}
function cancel() { cleanup(); process.exit(0); }

function onKey(d) {
  if (form.busy) return;
  // A single read may batch several 3-byte CSI sequences (fast arrows / key-repeat) — apply each.
  if (d.length >= 3 && d[0] === 0x1b && d[1] === 0x5b && d.length % 3 === 0 &&
      [...d].every((b, i) => i % 3 !== 0 || b === 0x1b)) {
    for (let i = 0; i < d.length; i += 3) {
      const k = d[i + 2];
      if (k === 0x41) moveField(-1);      // Up
      else if (k === 0x42) moveField(1);  // Down
      else if (k === 0x43) changeField(1); // Right
      else if (k === 0x44) changeField(-1); // Left
      else if (k === 0x5a) moveField(-1); // Shift-Tab
    }
    return;
  }
  if (d.length === 1) {
    const b = d[0];
    if (b === 0x03 || b === 0x1b) return cancel();     // Ctrl-C / Esc
    if (b === 0x0d || b === 0x0a) return submit();      // Enter
    if (b === 0x09) return moveField(1);                // Tab
    if (b === 0x7f || b === 0x08) return backspace();
    const f = form.fields[form.idx];
    if (b === 0x20 && (f.type === 'bool' || f.type === 'select')) return changeField(1);
    if (b === 0x20 && f.type === 'button') return submit();
    if (f.type === 'text' && b >= 0x20 && b < 0x7f) { f.value += String.fromCharCode(b); return render(); }
    return;
  }
  // pasted / multibyte input into a text field
  const f = form.fields[form.idx];
  if (f.type === 'text') { f.value += d.toString('utf8').replace(/[\x00-\x1f]/g, ''); render(); }
}

function main() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', render);
  process.on('exit', cleanup);
  render();
  // enrich model/effort from the server (best-effort; falls back to the static lists)
  getJSON('/api/capabilities', (e, d) => {
    if (d) {
      const models = flattenModels(d.models);
      if (models.length) setOptions('model', ['default', ...models]);
      if (Array.isArray(d.efforts) && d.efforts.length) setOptions('effort', ['default', ...d.efforts]);
      render();
    }
  });
  getJSON('/api/defaults', (e, d) => {
    if (d) { preselect('model', d.model); preselect('effort', d.effort); render(); }
  });
}

main();
