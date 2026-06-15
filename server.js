#!/usr/bin/env node
'use strict';
/*
 * hooked — serveur du dashboard local (point d'entrée HTTP).
 * La logique métier vit dans server/* (parsing, coût, état live, tmux, stats).
 * Ici : routing de la petite API JSON, fichiers statiques, flux SSE temps réel.
 *
 * Runtime zéro dépendance (stdlib Node uniquement). Le front Svelte est buildé dans dist/.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const {
  PROJECTS_DIR, HOOKED_DIR, EVENTS_FILE, PUBLIC_DIR, PORT,
  buildSessions, buildStats, sessionDetail,
  scanSessions, agentTranscriptPath, buildConversation, buildFileChanges,
  projectFiles, matchFiles, slashCommands, matchCommands, paneForSession, liveQuestionForSession,
  deliverReply, deliverQuestion, sendKey, setMode, setModelEffort, launchSession, killSession, tmuxAlive,
  saveImage,
} = require('./server/index.js');

// ---------- SSE ----------
const sseClients = new Set();
function broadcast() {
  for (const res of sseClients) {
    try { res.write('data: tick\n\n'); } catch (_) {}
  }
}
// pousse à chaque écriture d'évènement de hook (débounce) + heartbeat régulier
let debounce = null;
const pushSoon = () => { clearTimeout(debounce); debounce = setTimeout(broadcast, 250); };
try {
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  fs.watch(HOOKED_DIR, pushSoon);
} catch (_) {}
// temps réel sur les updates de Claude : on observe aussi l'arborescence des transcripts
// (récursif — supporté sur macOS/Windows) pour pousser dès qu'un message est écrit.
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, pushSoon);
} catch (_) {}
setInterval(broadcast, 4000).unref();

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json',
};
// Page servie quand le front n'a pas encore été buildé (dist/ absent).
const NO_BUILD_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>🪝 hooked</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f2ea;color:#3a2f25;display:grid;place-items:center;height:100vh;margin:0}
.box{max-width:460px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}
code{background:#ece6d8;padding:2px 7px;border-radius:6px}</style></head>
<body><div class="box"><h1>🪝 hooked</h1><p>Le front n'est pas encore buildé.</p>
<p>Lance <code>npm run build</code> puis recharge la page.</p></div></body></html>`;

function sendJSON(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, cb, maxBytes = 1e6) {
  let raw = '';
  let tooBig = false;
  req.on('data', (d) => {
    raw += d;
    if (raw.length > maxBytes) { tooBig = true; req.destroy(); } // garde-fou taille
  });
  req.on('end', () => {
    if (tooBig) return cb(new Error('body too large'));
    try { cb(null, raw ? JSON.parse(raw) : {}); } catch (e) { cb(e); }
  });
  req.on('error', cb);
}

function serveStatic(res, p) {
  const fp = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) {
      // SPA fallback : sert index.html pour les routes inconnues sans extension.
      if (!path.extname(p)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(503, { 'Content-Type': MIME['.html'] }); return res.end(NO_BUILD_HTML); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  try {
    if (req.method === 'POST' && p === '/api/reply') {
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        const id = body && body.id;
        if (!id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'id requis' })); }
        const pane = paneForSession(id);
        if (!pane) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: 'pane tmux inconnu pour cette session (lancée hors tmux, ou avant ce hook ?)' })); }
        const done = (e2) => {
          if (e2) { res.writeHead(502); return res.end(JSON.stringify({ ok: false, error: 'échec tmux send-keys : ' + (e2.message || e2) })); }
          sendJSON(res, { ok: true, pane });
        };
        // Réponse à un AskUserQuestion : on reçoit les INDICES sélectionnés par question et on
        // pilote le TUI au clavier (↓/Espace/Entrée). Bien plus fiable que taper les labels —
        // un multi-select se *navigue*, il ne se *tape* pas.
        const sel = body && body.selections;
        if (Array.isArray(sel)) {
          if (!sel.length) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'sélections vides' })); }
          const selections = sel.map((q) => ({
            multi: !!(q && q.multi),
            indices: Array.isArray(q && q.indices) ? q.indices.filter((n) => Number.isInteger(n) && n >= 0) : [],
          }));
          return deliverQuestion(pane, selections, done);
        }
        // `text` : string (texte libre / réponse à choix unique tapée) ou tableau d'intitulés.
        const raw = body && body.text;
        const text = Array.isArray(raw)
          ? raw.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
          : (typeof raw === 'string' ? raw.trim() : '');
        const empty = Array.isArray(text) ? !text.length : !text;
        if (empty) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'text requis' })); }
        // si une question AskUserQuestion est en attente, son TUI réclame une Entrée de
        // confirmation supplémentaire (écran « Submit answers ») pour valider la réponse.
        const isQuestion = !!liveQuestionForSession(id);
        deliverReply(pane, text, isQuestion, done);
      });
    }
    if (req.method === 'POST' && p === '/api/upload-image') {
      // image collée dans le composer : on l'écrit sur disque (machine locale) et on renvoie
      // son chemin absolu, que le composer joindra au message (Claude Code lit l'image par chemin).
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide (image trop lourde ?)' })); }
        saveImage(body && body.dataUrl, (e2, info) => {
          if (e2) { res.writeHead(e2.code === 400 ? 400 : 500); return res.end(JSON.stringify({ ok: false, error: e2.message || String(e2) })); }
          sendJSON(res, { ok: true, ...info });
        });
      }, 22e6); // base64 gonfle ~33 % → marge au-dessus de la limite 15 Mo des images
    }
    if (req.method === 'POST' && p === '/api/interrupt') {
      // Echap dans la session interactive : interrompt Claude (comme une frappe Echap au clavier).
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        const id = body && body.id;
        if (!id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'id requis' })); }
        const pane = paneForSession(id);
        if (!pane || !tmuxAlive(pane)) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: 'aucun pane tmux vivant pour cette session' })); }
        sendKey(pane, 'Escape', (e2) => {
          if (e2) { res.writeHead(502); return res.end(JSON.stringify({ ok: false, error: 'échec tmux send-keys : ' + (e2.message || e2) })); }
          sendJSON(res, { ok: true, pane });
        });
      });
    }
    if (req.method === 'POST' && p === '/api/mode') {
      // Change le mode de permission de Claude (Normal / Auto-edits / Plan) dans la session
      // interactive en simulant des Maj+Tab, comme au clavier dans le TUI.
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        const id = body && body.id;
        const mode = body && body.mode;
        if (!id || !mode) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'id et mode requis' })); }
        const pane = paneForSession(id);
        if (!pane || !tmuxAlive(pane)) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: 'aucun pane tmux vivant pour cette session' })); }
        // boucle fermée : setMode lit le mode réel à l'écran et envoie des Maj+Tab jusqu'à la cible.
        setMode(pane, mode, (e2, info) => {
          if (e2) { res.writeHead(e2.code === 400 ? 400 : 502); return res.end(JSON.stringify({ ok: false, error: e2.message || String(e2) })); }
          sendJSON(res, { ok: true, ...info });
        });
      });
    }
    if (req.method === 'POST' && p === '/api/model') {
      // Change le modèle et/ou l'effort d'une session live en envoyant `/model` et `/effort`
      // dans le TUI (comme au clavier), à la manière du changement de mode de permission.
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        const id = body && body.id;
        const model = body && body.model;
        const effort = body && body.effort;
        if (!id || (!model && !effort)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'id et (modèle ou effort) requis' })); }
        const pane = paneForSession(id);
        if (!pane || !tmuxAlive(pane)) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: 'aucun pane tmux vivant pour cette session' })); }
        setModelEffort(pane, { model, effort, sessionId: id }, (e2, info) => {
          if (e2) { res.writeHead(e2.code === 400 ? 400 : 502); return res.end(JSON.stringify({ ok: false, error: e2.message || String(e2) })); }
          sendJSON(res, { ok: true, ...info });
        });
      });
    }
    if (req.method === 'POST' && p === '/api/launch') {
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        launchSession(body || {}, (e, info) => {
          if (e) { res.writeHead(e.code === 400 ? 400 : 502); return res.end(JSON.stringify({ ok: false, error: e.message || String(e) })); }
          sendJSON(res, { ok: true, ...info });
        });
      });
    }
    if (req.method === 'POST' && p === '/api/kill') {
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        const id = body && body.id;
        if (!id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'id requis' })); }
        killSession(id, (e, info) => {
          if (e) { res.writeHead(e.code === 400 ? 400 : 502); return res.end(JSON.stringify({ ok: false, error: e.message || String(e) })); }
          sendJSON(res, { ok: true, ...info });
        });
      });
    }
    if (p === '/api/sessions') return sendJSON(res, { sessions: buildSessions(), now: new Date().toISOString() });
    if (p === '/api/stats') {
      const range = u.query.range;
      const days = range === 'all' ? 0 : parseInt(range || '7', 10);
      return sendJSON(res, buildStats(days));
    }
    if (p === '/api/files') {
      // auto-complétion @ : fichiers du projet. cwd explicite (nouvelle session, pas encore
      // d'id) prioritaire, sinon dérivé de la session ouverte.
      let cwd = u.query.cwd && typeof u.query.cwd === 'string' ? u.query.cwd : null;
      if (!cwd) { const sess = scanSessions().find((x) => x.id === u.query.id); cwd = sess && sess.project; }
      if (!cwd) return sendJSON(res, { files: [] });
      const st = fs.statSync(cwd, { throwIfNoEntry: false });
      if (!st || !st.isDirectory()) return sendJSON(res, { files: [] });
      const files = matchFiles(projectFiles(cwd), u.query.q || '');
      return sendJSON(res, { files });
    }
    if (p === '/api/commands') {
      // auto-complétion « / » : commandes custom (.claude/commands) + built-in (curées +
      // extraites du binaire claude). cwd explicite (nouvelle session) prioritaire.
      let cwd = u.query.cwd && typeof u.query.cwd === 'string' ? u.query.cwd : null;
      if (!cwd) { const sess = scanSessions().find((x) => x.id === u.query.id); cwd = sess && sess.project; }
      const commands = matchCommands(slashCommands(cwd), u.query.q || '');
      return sendJSON(res, { commands });
    }
    if (p === '/api/session') {
      const d = sessionDetail(u.query.id);
      if (!d) { res.writeHead(404); return res.end('{}'); }
      return sendJSON(res, d);
    }
    if (p === '/api/agent') {
      // déroulé interne complet d'un sous-agent (sa propre conversation : tools, reads, edits…)
      const fp = agentTranscriptPath(u.query.session, u.query.agent);
      if (!fp) { res.writeHead(404); return res.end('{}'); }
      const messages = buildConversation(fp, true); // tout le fichier est isSidechain
      const changes = buildFileChanges(fp);
      return sendJSON(res, { agent: u.query.agent, messages, changes });
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    return serveStatic(res, p);
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.message || e));
  }
});

server.listen(PORT, () => {
  console.log(`\n  🪝  hooked — dashboard sur http://localhost:${PORT}\n`);
  console.log(`  Sessions scannées dans ${PROJECTS_DIR}`);
  console.log(`  Évènements live depuis ${EVENTS_FILE}\n`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    console.warn('  ⚠️  Front non buildé — lance `npm run build` (l\'UI sera indisponible sinon).\n');
  }
});
