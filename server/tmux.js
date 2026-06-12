'use strict';
/*
 * Pilotage tmux : résolution pane→nom de session, livraison de réponses (send-keys),
 * lancement / reprise / arrêt de sessions `claude` interactives (abonnement, zéro conso token).
 */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { LAUNCHES_FILE, SESSION_LAUNCH_FILE, MODELS, EFFORTS, PERMISSION_MODES } = require('./config');
const { statSafe } = require('./util');
const { launchConfigByTmux, paneForSession } = require('./events');
const { scanSessions } = require('./transcript');

// map pane tmux (%NN) → nom de session tmux, rafraîchie au plus toutes les 3 s.
let paneNameCache = { at: 0, map: new Map() };
function paneTmuxNames() {
  const now = Date.now();
  if (now - paneNameCache.at < 3000) return paneNameCache.map;
  const map = new Map();
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{session_name}'], { encoding: 'utf8', timeout: 1500 });
    for (const line of out.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp > 0) map.set(line.slice(0, sp), line.slice(sp + 1).trim());
    }
  } catch (_) { /* tmux absent ou aucun serveur : pas grave */ }
  paneNameCache = { at: now, map };
  return map;
}

// le pane tmux est-il *toujours vivant* ? (présent dans la liste des panes courants)
// Sert à distinguer une session live d'une session dont le tmux a été fermé/tué : on ne
// connaît qu'un *dernier* pane via les évènements, mais il peut ne plus exister.
function tmuxAlive(pane) {
  if (!/^%\d+$/.test(pane || '')) return false;
  return paneTmuxNames().has(pane);
}

// effort/modèle explicitement choisis au lancement pour une session live (sinon null).
function launchInfoForPane(pane) {
  if (!pane) return null;
  const name = paneTmuxNames().get(pane);
  if (!name) return null;
  return launchConfigByTmux().get(name) || null;
}

// map persistée session_id → { model, effort }, rechargée par mtime/size.
let sessionLaunchCache = { key: null, map: new Map() };
function sessionLaunchMap() {
  const st = statSafe(SESSION_LAUNCH_FILE);
  if (!st) return sessionLaunchCache.map;
  const key = st.mtimeMs + ':' + st.size;
  if (sessionLaunchCache.key === key) return sessionLaunchCache.map;
  const map = new Map();
  let data = '';
  try { data = fs.readFileSync(SESSION_LAUNCH_FILE, 'utf8'); } catch (_) { return sessionLaunchCache.map; }
  for (const line of data.split('\n')) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j.session_id) map.set(j.session_id, { model: j.model || null, effort: j.effort || null }); } catch (_) {}
  }
  sessionLaunchCache = { key, map };
  return map;
}

// modèle/effort d'une session, en privilégiant la résolution persistée (survit à la mort du
// tmux). À défaut, résolution live (pane→nom→launches) que l'on persiste alors pour la suite.
function resolveLaunchForSession(id) {
  if (!id) return null;
  const persisted = sessionLaunchMap().get(id);
  if (persisted) return persisted;
  const pane = paneForSession(id);
  const li = launchInfoForPane(pane);
  if (li && (li.model || li.effort)) {
    try {
      fs.appendFileSync(SESSION_LAUNCH_FILE, JSON.stringify({ ts: new Date().toISOString(), session_id: id, model: li.model || null, effort: li.effort || null }) + '\n');
    } catch (_) {}
    return li;
  }
  return null;
}

// Renvoie le message dans la session interactive via tmux : on « tape » le texte
// dans le pane puis on valide avec Entrée (session/abonnement en cours, zéro conso token).
// `isQuestion` : on répond à un AskUserQuestion. Son TUI multi-étapes se termine sur un
// écran de confirmation « Submit answers » qui réclame une *seconde* Entrée — sans elle la
// réponse est saisie mais jamais validée (« envoyé » côté UI mais la session reste bloquée).
function deliverReply(pane, text, isQuestion, cb) {
  if (typeof isQuestion === 'function') { cb = isQuestion; isQuestion = false; }
  if (!/^%\d+$/.test(pane || '')) return cb(new Error('pane invalide'));
  execFile('tmux', ['send-keys', '-t', pane, '-l', '--', text], (err) => {
    if (err) return cb(err);
    // petit délai pour laisser le TUI ingérer le collage avant de valider
    setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (e2) => {
      if (e2 || !isQuestion) return cb(e2 || null);
      // 2e Entrée : valide l'écran « Submit answers » de l'AskUserQuestion.
      setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (e3) => cb(e3 || null)), 200);
    }), 120);
  });
}

// Envoie une touche « nommée » (ex. Escape) au pane : sert à interrompre Claude depuis l'UI,
// exactement comme une frappe Echap dans le TUI interactif.
function sendKey(pane, key, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('pane invalide'));
  if (!/^[A-Za-z0-9]+$/.test(key || '')) return cb(err400('touche invalide'));
  execFile('tmux', ['send-keys', '-t', pane, key], (e) => cb(e || null));
}

// Mode de permission lu DIRECTEMENT à l'écran du TUI (footer). C'est la source fiable et
// temps-réel : le TUI affiche en dernière ligne « ⏵⏵ auto mode on (shift+tab to cycle) »,
// « ⏵⏵ accept edits on … », « ⏸ plan mode on … » ; en mode normal il n'y a pas de ligne
// d'indicateur (la dernière ligne non vide est la statusline). On ne regarde QUE la dernière
// ligne non vide pour ne pas confondre avec le texte de la conversation qui pourrait citer
// ces libellés.
function parsePaneMode(screen) {
  const lines = String(screen).split('\n');
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { last = lines[i]; break; } }
  if (/auto mode on/i.test(last)) return 'auto';
  if (/accept edits on/i.test(last)) return 'acceptEdits';
  if (/plan mode on/i.test(last)) return 'plan';
  if (/bypass permissions/i.test(last)) return 'bypassPermissions';
  return 'default'; // mode normal : pas d'indicateur de mode dans le footer
}

// Lecture asynchrone du mode courant via `tmux capture-pane`.
function readPaneMode(pane, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('pane invalide'));
  execFile('tmux', ['capture-pane', '-t', pane, '-p'], (e, out) => {
    if (e) return cb(e);
    cb(null, parsePaneMode(out));
  });
}

// Lecture synchrone (pour enrichir le détail de session sans casser son API synchrone).
function readPaneModeSync(pane) {
  if (!/^%\d+$/.test(pane || '')) return null;
  try {
    const out = execFileSync('tmux', ['capture-pane', '-t', pane, '-p'], { encoding: 'utf8', timeout: 1500 });
    return parsePaneMode(out);
  } catch (_) { return null; }
}

// Change le mode de permission d'une session live en BOUCLE FERMÉE : on lit le mode affiché,
// et tant qu'il diffère de la cible on envoie un Maj+Tab (`BTab`) puis on relit le footer.
// Robuste à n'importe quel ordre/longueur de cycle (l'ordre réel observé est
// default → acceptEdits → plan → auto → …, mais on ne s'y fie pas), et auto-vérifié.
function setMode(pane, target, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('pane invalide'));
  if (!PERMISSION_MODES.includes(target)) return cb(err400('mode inconnu : ' + target));
  const MAX = 6; // garde-fou : au plus 6 modes dans le cycle → jamais de boucle infinie
  const step = (n) => {
    readPaneMode(pane, (e, cur) => {
      if (e) return cb(e);
      if (cur === target) return cb(null, { pane, mode: target, presses: n });
      if (n >= MAX) return cb(new Error(`mode « ${target} » non atteint après ${n} Maj+Tab (mode courant : ${cur})`));
      execFile('tmux', ['send-keys', '-t', pane, 'BTab'], (e2) => {
        if (e2) return cb(e2);
        setTimeout(() => step(n + 1), 160); // laisser le TUI re-render le footer avant relecture
      });
    });
  };
  step(0);
}

function err400(msg) { const e = new Error(msg); e.code = 400; return e; }

// Lance `claude` (ou `claude --resume <id>`) dans une NOUVELLE session tmux détachée.
function launchSession({ resumeId, cwd, prompt, model, effort }, cb) {
  let dir = cwd && typeof cwd === 'string' ? cwd : null;
  let id = null;
  if (resumeId) {
    if (!/^[A-Za-z0-9._-]+$/.test(resumeId)) return cb(err400('id de session invalide'));
    const sess = scanSessions().find((s) => s.id === resumeId);
    if (!sess) return cb(err400('session introuvable'));
    dir = dir || sess.project; // on reprend dans le dossier d'origine de la session
    id = resumeId;
  }
  if (!dir) return cb(err400('dossier (cwd) requis'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('cwd invalide : ' + dir));

  // model/effort : validés contre une liste blanche (sécurise l'injection shell ET rejette l'inconnu).
  if (model && !MODELS.includes(model)) return cb(err400('modèle inconnu : ' + model));
  if (effort && !EFFORTS.includes(effort)) return cb(err400('effort inconnu : ' + effort));
  let flags = '';
  if (model) flags += ` --model ${model}`;
  if (effort) flags += ` --effort ${effort}`;
  const claudeCmd = `claude${id ? ` --resume ${id}` : ''}${flags}`;
  const base = path.basename(dir).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'session';
  const name = `hooked-${base}-${Date.now().toString(36).slice(-5)}`;

  // `claude` comme commande du shell de login interactif (-ic) : PATH du profil chargé,
  // `exec $SHELL` garde le pane vivant après la sortie de claude.
  const shell = process.env.SHELL || '/bin/zsh';
  const shellCmd = `${shell} -ic '${claudeCmd}; exec ${shell}'`;

  execFile('tmux', ['new-session', '-d', '-s', name, '-c', dir, shellCmd], (e1) => {
    if (e1) return cb(new Error('tmux new-session a échoué : ' + (e1.message || e1)));
    // mémorise modèle/effort choisis pour pouvoir les afficher sur la session live.
    try {
      fs.appendFileSync(LAUNCHES_FILE, JSON.stringify({ ts: new Date().toISOString(), tmux: name, cwd: dir, model: model || null, effort: effort || null }) + '\n');
    } catch (_) {}
    // 1er prompt optionnel : best-effort, après un délai pour laisser le TUI claude démarrer.
    const seed = prompt && typeof prompt === 'string' ? prompt.trim() : '';
    if (seed) {
      setTimeout(() => execFile('tmux', ['send-keys', '-t', name, '-l', '--', seed], () => {
        setTimeout(() => execFile('tmux', ['send-keys', '-t', name, 'Enter'], () => {}), 250);
      }), 3500);
    }
    cb(null, { tmux: name, attach: `tmux attach -t ${name}`, cwd: dir, resume: id });
  });
}

// Stoppe la session : on tue le pane tmux où tourne claude.
function killSession(id, cb) {
  const pane = require('./events').paneForSession(id);
  if (!pane) return cb(err400('pane tmux inconnu pour cette session (lancée hors tmux ?)'));
  if (!/^%\d+$/.test(pane)) return cb(err400('pane invalide'));
  execFile('tmux', ['kill-pane', '-t', pane], (e) => {
    if (e) return cb(new Error('tmux kill-pane a échoué : ' + (e.message || e)));
    cb(null, { pane });
  });
}

module.exports = { paneTmuxNames, tmuxAlive, launchInfoForPane, resolveLaunchForSession, deliverReply, sendKey, parsePaneMode, readPaneMode, readPaneModeSync, setMode, launchSession, killSession, err400 };
