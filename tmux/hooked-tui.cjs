#!/usr/bin/env node
'use strict';

// hooked sidebar TUI — a zero-dependency terminal list of active hooked sessions,
// rendered inside a tmux pane. Moving the highlight (j/k) switches the tmux client
// to the corresponding session and relocates THIS pane into that session's window so
// the sidebar follows you (opensessions-style). Only ever moves our own pane; the
// Claude panes hooked tracks are never touched.
//
// Env (set by hooked-sidebar.sh):
//   HOOKED_PORT            hooked server port (default 4123)
//   HOOKED_MCP_URL         base URL, overrides HOOKED_PORT
//   HOOKED_SIDEBAR_WIDTH   pane width used when re-joining on switch (default 40)
//   TMUX_PANE              our own pane id (%NN), provided by tmux automatically

const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const HOME = os.homedir();

const PORT = process.env.HOOKED_PORT || '4123';
const BASE = (process.env.HOOKED_MCP_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const WIDTH = parseInt(process.env.HOOKED_SIDEBAR_WIDTH || '40', 10) || 40;
const SELF = process.env.TMUX_PANE || '';

// Inbox "Active" = live pane in one of these states (mirrors hooked's sidebar scope).
const ACTIVE = new Set(['working', 'background', 'waiting', 'attention']);
const STATE_ORDER = { attention: 0, waiting: 1, working: 2, background: 3, idle: 4 };

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', rev: '\x1b[7m', bold: '\x1b[1m',
  red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m',
  cyan: '\x1b[36m', green: '\x1b[32m', gray: '\x1b[90m',
};
const STATE_STYLE = {
  attention: { c: C.red, dot: '●' },
  waiting: { c: C.yellow, dot: '●' },
  working: { c: C.blue, dot: '●' },
  background: { c: C.cyan, dot: '◍' },
  idle: { c: C.gray, dot: '○' },
  ended: { c: C.gray, dot: '○' },
  past: { c: C.gray, dot: '○' },
};

if (!SELF) {
  process.stderr.write('hooked-tui: no $TMUX_PANE — must run inside tmux.\n');
  process.exit(1);
}

const state = {
  raw: [],       // last raw /api/sessions payload
  sessions: [],  // visible() of raw (active-filter + text-filter, sorted)
  idx: 0,
  top: 0,
  filter: '',        // text-filter query
  filtering: false,  // typing into the filter
  pendingKill: null, // session awaiting a stop confirmation
  status: '',        // transient one-line message (kill result…)
  err: null,
  // session we last switched the client to (starts as the session we were opened in)
  curTarget: null,
  origin: null,
  landed: false, // set once we've placed the initial highlight on the origin session
};

function tmux(args) {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 2000 });
  } catch (_) {
    return null;
  }
}

// pane id (%NN) -> tmux session name, resolved fresh (panes move as we relocate).
function paneToSession() {
  const out = tmux(['list-panes', '-a', '-F', '#{pane_id} #{session_name}']) || '';
  const m = new Map();
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return m;
}

function currentSessionName() {
  const out = tmux(['display-message', '-p', '-t', SELF, '#{session_name}']);
  return out ? out.trim() : null;
}

// Switch the client to `sess`'s session and re-join our pane on its left edge so the
// sidebar follows. `-f` spans full window height; omitting `-d` keeps focus on us so
// the next keystroke still reaches the TUI.
function switchTo(sess) {
  if (!sess || !sess.tmuxAlive || !sess.tmuxPane) return;
  const target = paneToSession().get(sess.tmuxPane);
  if (!target) return;
  if (target === state.curTarget) return; // already there, don't thrash
  tmux(['switch-client', '-t', target]);
  tmux(['join-pane', '-hb', '-f', '-l', String(WIDTH), '-s', SELF, '-t', target + ':']);
  tmux(['select-pane', '-t', SELF, '-T', 'hooked-sidebar']);
  state.curTarget = target;
}

function fetchJSON(path, cb) {
  const req = http.get(BASE + path, { timeout: 3000 }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      try { cb(null, JSON.parse(body)); } catch (e) { cb(e); }
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
}

function postJSON(path, body, cb) {
  const data = Buffer.from(JSON.stringify(body));
  const u = new URL(BASE + path);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 5000,
  }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) return cb(null, b);
      let msg = `HTTP ${res.statusCode}`;
      try { const j = JSON.parse(b); msg = j.error || j.message || msg; } catch (_) {}
      cb(new Error(msg));
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.end(data);
}

function matchesFilter(s) {
  if (!state.filter) return true;
  const hay = `${s.title || ''} ${s.projectName || ''} ${s.repo || ''} ${s.project || ''} ${s.gitBranch || ''} ${s.lastPrompt || ''}`.toLowerCase();
  return state.filter.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

function visible(sessions) {
  return sessions
    .filter((s) => s.tmuxAlive && (ACTIVE.has(s.state) || s.hasQuestion || s.hasPlan))
    .filter(matchesFilter)
    .sort((a, b) => {
      const oa = STATE_ORDER[a.state] ?? 9;
      const ob = STATE_ORDER[b.state] ?? 9;
      if (oa !== ob) return oa - ob;
      return String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
    });
}

// Rebuild the visible list from the last raw payload (no network) — after a fetch or a filter edit.
function recompute() {
  const prevId = state.sessions[state.idx] && state.sessions[state.idx].id;
  state.sessions = visible(state.raw);
  if (!state.landed && state.origin) {
    const map = paneToSession();
    const i = state.sessions.findIndex((s) => map.get(s.tmuxPane) === state.origin);
    if (i >= 0) state.idx = i;
    state.landed = true;
  } else if (prevId) {
    const i = state.sessions.findIndex((s) => s.id === prevId);
    if (i >= 0) state.idx = i;
  }
  if (state.idx >= state.sessions.length) state.idx = Math.max(0, state.sessions.length - 1);
  render();
}

function refresh() {
  fetchJSON('/api/sessions', (err, data) => {
    if (err) { state.err = err.message || 'unreachable'; render(); return; }
    state.err = null;
    state.raw = data.sessions || [];
    recompute();
  });
}

function cols() { return process.stdout.columns || WIDTH; }
function rows() { return process.stdout.rows || 24; }

function truncate(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return s.slice(0, n - 1) + '…';
}

function titleOf(s) {
  return s.title || s.projectName || '(untitled)';
}

// project path, home abbreviated to ~; falls back to repo/projectName if no cwd.
function pathOf(s) {
  let p = s.project || '';
  if (p && HOME && (p === HOME || p.startsWith(HOME + '/'))) p = '~' + p.slice(HOME.length);
  return p || s.repo || s.projectName || '';
}

// keep the tail of a path (its end is the informative part) with a leading ellipsis.
function truncLeft(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(-n);
  return '…' + s.slice(-(n - 1));
}

function render() {
  const W = cols();
  const H = rows();
  const footerRows = 3; // grouped keybinding help occupies the bottom 3 rows
  const listH = Math.max(2, H - 1 - footerRows);
  const perScreen = Math.max(1, Math.floor(listH / 2)); // two lines per session

  // viewport scroll around the highlight
  if (state.idx < state.top) state.top = state.idx;
  if (state.idx >= state.top + perScreen) state.top = state.idx - perScreen + 1;

  const out = [];
  out.push('\x1b[H\x1b[2J'); // home + clear

  const count = state.sessions.length;
  const filterTag = state.filter && !state.filtering ? ` ${C.cyan}/${state.filter}${C.reset}` : '';
  const header = ` ${C.bold}hooked${C.reset}${C.dim} · ${count} active${C.reset}${filterTag}`;
  out.push('\x1b[1;1H\x1b[2K' + header);

  if (state.err) {
    out.push('\x1b[3;1H' + C.red + truncate(' ' + state.err, W) + C.reset);
    out.push(`\x1b[4;1H${C.dim}` + truncate(' server on ' + BASE + '?', W) + C.reset);
  } else if (count === 0) {
    out.push(`\x1b[3;1H${C.dim} no active sessions${C.reset}`);
  } else {
    for (let r = 0; r < perScreen; r++) {
      const i = state.top + r;
      if (i >= count) break;
      const s = state.sessions[i];
      const sel = i === state.idx;
      const st = STATE_STYLE[s.state] || STATE_STYLE.idle;
      const flag = s.hasQuestion ? '?' : s.hasPlan ? '✎' : '';
      const marker = sel ? '▸' : ' ';
      const rowTop = 2 + 2 * r;

      // line 1 — state dot + title (+ question/plan flag)
      const avail = W - 5 - (flag ? 2 : 0); // prefix " ▸ ● " is 5 cols; flag is " x" (2)
      const name = truncate(titleOf(s), Math.max(1, avail));
      const pad = ' '.repeat(Math.max(0, avail - name.length));
      let tline = ` ${marker} ${st.c}${st.dot}${C.reset} ${name}${pad}`;
      if (flag) tline += ` ${C.dim}${flag}${C.reset}`;
      if (sel) {
        const plain = ` ${marker} ${st.dot} ${name}${pad}${flag ? ' ' + flag : ''}`;
        tline = C.rev + truncate(plain, W) + ' '.repeat(Math.max(0, W - plain.length)) + C.reset;
      }
      out.push(`\x1b[${rowTop};1H` + tline);

      // line 2 — project path, dimmed, indented under the title
      const pth = truncLeft(pathOf(s), Math.max(1, W - 5));
      out.push(`\x1b[${rowTop + 1};1H     ${C.dim}${pth}${C.reset}`);
    }
  }

  if (state.filtering) {
    out.push(`\x1b[${H};1H\x1b[2K ${C.cyan}/${C.reset}${state.filter}${C.rev} ${C.reset}`);
  } else if (state.pendingKill) {
    out.push(`\x1b[${H};1H\x1b[2K ${C.red}stop${C.reset} “${truncate(titleOf(state.pendingKill), W - 14)}” ? ${C.dim}y/n${C.reset}`);
  } else if (state.status) {
    out.push(`\x1b[${H};1H\x1b[2K ${state.status}`);
  } else {
    // grouped keybinding help across the bottom `footerRows` lines (cyan keys, dim labels)
    const K = (k) => `${C.cyan}${k}${C.reset}`;
    const L = (t) => `${C.dim}${t}${C.reset}`;
    const help = [
      ` ${K('j/k')}${L(' switch')}  ${K('1-9')}${L(' jump')}`,
      ` ${K('/')}${L(' filter')}  ${K('d')}${L(' stop')}  ${K('n')}${L(' new')}`,
      ` ${K('↵')}${L(' open')}  ${K('q')}${L(' back')}`,
    ];
    for (let i = 0; i < help.length; i++) {
      out.push(`\x1b[${H - footerRows + 1 + i};1H\x1b[2K` + help[i]);
    }
  }
  process.stdout.write(out.join(''));
}

function move(delta) {
  if (!state.sessions.length) return;
  state.idx = Math.max(0, Math.min(state.sessions.length - 1, state.idx + delta));
  switchTo(state.sessions[state.idx]);
  render();
}

function jump(n) {
  if (n < 1 || n > state.sessions.length) return;
  state.idx = n - 1;
  switchTo(state.sessions[state.idx]);
  render();
}

// Open the new-session form in a tmux popup. Non-blocking: the popup grabs client input,
// self-submits to /api/launch, and the sidebar picks up the new session over SSE on close.
// process.execPath guarantees the popup finds node regardless of tmux's run-shell PATH.
function newSessionPopup() {
  const sel = state.sessions[state.idx];
  const defDir = (sel && (sel.project || '')).replace(/'/g, '');
  const bin = path.join(__dirname, 'hooked-new.cjs');
  const cmd = `HOOKED_MCP_URL='${BASE}' exec '${process.execPath}' '${bin}' '${defDir}'`;
  try {
    execFile('tmux', ['display-popup', '-E', '-w', '72', '-h', '14', '-b', 'rounded',
      '-T', ' new hooked session ', cmd], () => {});
  } catch (_) {}
}

function killSelected() {
  const s = state.pendingKill;
  state.pendingKill = null;
  if (!s) return;
  state.status = `${C.yellow}stopping…${C.reset}`;
  render();
  postJSON('/api/kill', { id: s.id }, (err) => {
    state.status = err ? `${C.red}${err.message || err}${C.reset}` : '';
    refresh();
  });
}

function cleanup() {
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.stdout.write('\x1b[?1049l\x1b[?25h'); // leave alt screen, show cursor
}

// Enter: commit — stay on the currently selected session, close the sidebar.
function commit() { cleanup(); process.exit(0); }
// q / Esc: cancel — go back to where we opened from, close the sidebar.
function cancel() {
  if (state.origin && state.origin !== state.curTarget) tmux(['switch-client', '-t', state.origin]);
  cleanup();
  process.exit(0);
}

// Filter-input mode: keystrokes edit the query. Enter applies + jumps to the top match; Esc clears.
function onFilterKey(d) {
  if (d.length === 1) {
    const b = d[0];
    if (b === 0x1b || b === 0x03) { state.filtering = false; state.filter = ''; return recompute(); }
    if (b === 0x0d || b === 0x0a) {
      state.filtering = false;
      recompute();
      if (state.sessions[state.idx]) switchTo(state.sessions[state.idx]);
      return render();
    }
    if (b === 0x7f || b === 0x08) { state.filter = state.filter.slice(0, -1); return recompute(); }
    if (b >= 0x20 && b < 0x7f) { state.filter += String.fromCharCode(b); return recompute(); }
    return;
  }
  if (d[0] === 0x1b) return; // ignore arrow/escape sequences in filter mode
  const txt = d.toString('utf8').replace(/[\x00-\x1f]/g, '');
  if (txt) { state.filter += txt; recompute(); }
}

// Stop-confirmation mode: only 'y' confirms; anything else cancels.
function onConfirmKey(d) {
  const b = d.length === 1 ? d[0] : 0;
  if (b === 0x79 || b === 0x59) return killSelected(); // y / Y
  state.pendingKill = null;
  render();
}

function onKey(d) {
  if (state.filtering) return onFilterKey(d);
  if (state.pendingKill) return onConfirmKey(d);
  state.status = ''; // clear transient message on any nav key
  if (d.length === 1) {
    const b = d[0];
    if (b === 0x03) return cancel();          // Ctrl-C
    if (b === 0x0d || b === 0x0a) return commit(); // Enter
    if (b === 0x1b) return cancel();          // lone Esc
    const ch = String.fromCharCode(b);
    if (ch === 'q') return cancel();
    if (ch === 'j') return move(1);
    if (ch === 'k') return move(-1);
    if (ch === 'g') { state.idx = 0; switchTo(state.sessions[0]); return render(); }
    if (ch === 'G') return jump(state.sessions.length);
    if (ch === 'n') return newSessionPopup();
    if (ch === '/') { state.filtering = true; return render(); }
    if (ch === 'd') {
      if (state.sessions[state.idx]) { state.pendingKill = state.sessions[state.idx]; render(); }
      return;
    }
    if (ch >= '1' && ch <= '9') return jump(b - 0x30);
    return;
  }
  // escape sequences (arrows); a read may batch several 3-byte CSI sequences (key-repeat)
  if (d.length >= 3 && d[0] === 0x1b && d[1] === 0x5b && d.length % 3 === 0 &&
      [...d].every((b, i) => i % 3 !== 0 || b === 0x1b)) {
    for (let i = 0; i < d.length; i += 3) {
      const k = d[i + 2];
      if (k === 0x41) move(-1);      // Up
      else if (k === 0x42) move(1);  // Down
    }
  }
}

// Live refresh: any byte on the SSE tick channel -> debounced refetch, plus a slow poll.
let sseReq = null;
let debounce = null;
function scheduleRefresh() {
  if (debounce) return;
  debounce = setTimeout(() => { debounce = null; refresh(); }, 150);
}
function connectSSE() {
  sseReq = http.get(BASE + '/api/stream', (res) => {
    res.on('data', scheduleRefresh);
    res.on('end', () => setTimeout(connectSSE, 2000));
  });
  sseReq.on('error', () => setTimeout(connectSSE, 2000));
}

function main() {
  state.origin = currentSessionName();
  state.curTarget = state.origin;
  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', render);
  process.on('exit', cleanup);
  render();
  refresh();
  connectSSE();
  setInterval(refresh, 3000).unref();
}

main();
