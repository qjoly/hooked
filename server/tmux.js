/*
 * Pilotage tmux : résolution pane→nom de session, livraison de réponses (send-keys),
 * lancement / reprise / arrêt de sessions `claude` interactives (abonnement, zéro conso token).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { LAUNCHES_FILE, SESSION_LAUNCH_FILE, MODELS, EFFORTS, PERMISSION_MODES } from './config.js';
import { statSafe } from './util.js';
import { launchConfigByTmux, paneForSession } from './events.js';
import { scanSessions } from './transcript.js';

// Délai entre la saisie d'un texte et l'Entrée de validation. Le TUI de Claude Code détecte les
// frappes rapprochées comme un *collage* : une Entrée envoyée trop tôt après le texte est avalée
// comme un saut de ligne du collage (texte saisi mais jamais validé — « envoyé » côté UI, session
// bloquée). Il faut laisser la fenêtre de détection de collage se refermer avant de valider.
// Partagé entre deliverReply (réponses) et launchSession (1er prompt) pour rester cohérent.
const ENTER_DELAY = 400;

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

// Force le rafraîchissement du cache pane→nom au prochain appel. Utile juste après avoir créé
// un pane (ex. show_in_pane) : sans ça, un pane tout neuf reste « invisible » jusqu'à 3 s
// (tmuxAlive le verrait absent), retardant l'apparition de l'onglet Terminal côté UI.
function invalidatePaneCache() { paneNameCache.at = 0; }

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
//
// `isQuestion` : on répond à un AskUserQuestion. Son TUI affiche UN écran par question :
// on tape la réponse, Entrée passe à la question suivante (ou à l'écran « Submit answers »
// après la dernière), puis une *Entrée finale* valide cet écran de confirmation. `text` peut
// donc être un tableau (une entrée par question) : on enchaîne saisie + Entrée pour chacune
// avant la validation finale. Sans cette mécanique par étape, une réponse à plusieurs
// questions était saisie en bloc dans la 1re question et jamais validée (« envoyé » côté UI
// mais la session restait bloquée). Cas mono-question : [label] → 2 Entrées, comme avant.
function deliverReply(pane, text, isQuestion, cb) {
  if (typeof isQuestion === 'function') { cb = isQuestion; isQuestion = false; }
  if (!/^%\d+$/.test(pane || '')) return cb(new Error('pane invalide'));
  const answers = Array.isArray(text) ? text : [text];
  // tape une réponse puis Entrée, en laissant la fenêtre de détection de collage se refermer
  // avant de valider (cf. ENTER_DELAY).
  const typeAndEnter = (s, done) => execFile('tmux', ['send-keys', '-t', pane, '-l', '--', s], (err) => {
    if (err) return done(err);
    setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], done), ENTER_DELAY);
  });
  const step = (i) => {
    if (i >= answers.length) {
      if (!isQuestion) return cb(null);
      // Entrée finale : valide l'écran « Submit answers » de l'AskUserQuestion.
      return setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (e) => cb(e || null)), 200);
    }
    typeAndEnter(answers[i], (e) => {
      if (e) return cb(e);
      // délai entre deux questions : laisser le TUI afficher l'écran suivant avant de saisir.
      setTimeout(() => step(i + 1), 250);
    });
  };
  step(0);
}

// Répond à un AskUserQuestion en PILOTANT le TUI au clavier (et non en tapant les labels :
// taper « A, B » ne cochait rien — le TUI se *navigue*). Protocole vérifié en live sur le TUI
// (Claude Code v2.1.x), onglets « ← ☐ Question … ✔ Submit → » en tête d'écran :
//   • ↑/↓ déplacent le curseur dans les options (curseur sur la 1re option à l'arrivée) ;
//   • Entrée COCHE/décoche l'option sous le curseur (et non Espace) ;
//   • → passe à l'onglet suivant (question suivante, puis l'onglet « Submit ») ;
//   • sur l'onglet « Submit » (curseur déjà sur « Submit answers »), Entrée soumet.
// Donc, par question : descendre jusqu'à chaque option choisie + Entrée, puis → ; après la
// dernière question on est sur « Submit » → Entrée finale.
//
// CRITIQUE : les frappes doivent être largement espacées. Envoyées trop vite (≈90 ms), le TUI
// (ink) les coalesce / en avale — observé : un « ↓↓Entrée » rapproché perdait l'Entrée. ~300 ms
// entre deux touches rend chaque frappe fiable.
// `selections` : [{ multi: bool, indices: number[] }] (une entrée par question, dans l'ordre).
function deliverQuestion(pane, selections, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('pane invalide'));
  if (!Array.isArray(selections) || !selections.length) return cb(err400('sélections requises'));
  const KEY_DELAY = 300;     // entre deux touches (ink avale les frappes trop rapprochées)
  const SUBMIT_DELAY = 450;  // avant l'Entrée finale (laisser l'écran « Review » s'afficher)
  const press = (key, done) => execFile('tmux', ['send-keys', '-t', pane, key], (e) => (e ? done(e) : setTimeout(done, KEY_DELAY)));

  // suite de touches pour une question (curseur supposé sur la 1re option de l'écran), terminée
  // par → pour passer à l'onglet suivant (question suivante ou « Submit »).
  const keysFor = (q) => {
    const keys = [];
    const idx = (q.indices || []).filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
    let cur = 0; // position courante du curseur (départ : option 0)
    const targets = q.multi ? idx : (idx.length ? [idx[0]] : []);
    for (const target of targets) {
      for (let k = cur; k < target; k++) keys.push('Down');
      keys.push('Enter'); // coche l'option sous le curseur
      cur = target;
    }
    keys.push('Right'); // onglet suivant
    return keys;
  };

  const runKeys = (keys, done) => {
    const go = (i) => (i >= keys.length ? done(null) : press(keys[i], (e) => (e ? done(e) : go(i + 1))));
    go(0);
  };

  const stepQuestion = (qi) => {
    if (qi >= selections.length) {
      // sur l'onglet « Submit », curseur sur « Submit answers » → Entrée finale valide tout.
      return setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (e) => cb(e || null)), SUBMIT_DELAY);
    }
    runKeys(keysFor(selections[qi]), (e) => {
      if (e) return cb(e);
      stepQuestion(qi + 1);
    });
  };
  stepQuestion(0);
}

// Envoie une touche « nommée » (ex. Escape) au pane : sert à interrompre Claude depuis l'UI,
// exactement comme une frappe Echap dans le TUI interactif.
function sendKey(pane, key, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('pane invalide'));
  if (!/^[A-Za-z0-9]+$/.test(key || '')) return cb(err400('touche invalide'));
  execFile('tmux', ['send-keys', '-t', pane, key], (e) => cb(e || null));
}

// Mode de permission lu DIRECTEMENT à l'écran du TUI (footer). C'est la source fiable et
// temps-réel : le TUI affiche dans le footer « ⏵⏵ auto mode on (shift+tab to cycle) »,
// « ⏵⏵ accept edits on … », « ⏸ plan mode on … » ; en mode normal il n'y a pas de ligne
// d'indicateur. La ligne d'indicateur n'est PAS toujours la dernière non vide : quand des
// sous-agents tournent, le TUI ajoute des lignes en dessous (« ○ Explore … », etc.). On
// balaie donc les quelques dernières lignes non vides et on ne reconnaît une ligne de mode
// qu'avec le marqueur « (shift+tab to cycle) » (ou « bypass permissions »), absent du texte
// de conversation, pour ne pas se laisser piéger par un libellé cité plus haut.
function parsePaneMode(screen) {
  const lines = String(screen).split('\n');
  const tail = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 8; i--) {
    if (lines[i].trim()) tail.push(lines[i]);
  }
  for (const line of tail) {
    if (!/shift\+tab to cycle/i.test(line) && !/bypass permissions/i.test(line)) continue;
    if (/auto mode on/i.test(line)) return 'auto';
    if (/accept edits on/i.test(line)) return 'acceptEdits';
    if (/plan mode on/i.test(line)) return 'plan';
    if (/bypass permissions/i.test(line)) return 'bypassPermissions';
  }
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

// Change le modèle et/ou l'effort d'une session live en envoyant les commandes slash
// `/model <name>` et `/effort <level>` dans le TUI (exactement comme au clavier). On persiste
// ensuite le choix (fusionné avec l'existant) pour que l'UI le reflète même après la mort du
// tmux — l'effort réel reste de toute façon confirmé par la statusline au render suivant.
function setModelEffort(pane, { model, effort, sessionId }, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('pane invalide'));
  if (model && !MODELS.includes(model)) return cb(err400('modèle inconnu : ' + model));
  if (effort && !EFFORTS.includes(effort)) return cb(err400('effort inconnu : ' + effort));
  if (!model && !effort) return cb(err400('modèle ou effort requis'));
  const cmds = [];
  if (model) cmds.push('/model ' + model);
  if (effort) cmds.push('/effort ' + effort);
  const finish = () => {
    if (sessionId) {
      const prev = resolveLaunchForSession(sessionId) || {};
      const merged = { model: model || prev.model || null, effort: effort || prev.effort || null };
      try {
        fs.appendFileSync(SESSION_LAUNCH_FILE, JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, ...merged }) + '\n');
      } catch (_) {}
    }
    cb(null, { pane, model: model || null, effort: effort || null });
  };
  const step = (i) => {
    if (i >= cmds.length) return finish();
    execFile('tmux', ['send-keys', '-t', pane, '-l', '--', cmds[i]], (e) => {
      if (e) return cb(e);
      setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (e2) => {
        if (e2) return cb(e2);
        setTimeout(() => step(i + 1), 300); // laisser le TUI ingérer la commande avant la suivante
      }), 120);
    });
  };
  step(0);
}

// Lance `claude` (ou `claude --resume <id>`) dans une NOUVELLE session tmux détachée.
// `worktree` : démarre la session dans un git worktree dédié (`claude --worktree`) — ne vaut
// que pour une session neuve (incompatible avec une reprise, qui rouvre la session existante).
function launchSession({ resumeId, cwd, prompt, model, effort, worktree }, cb) {
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
  // worktree : sans objet sur une reprise (la session est rouverte dans son dossier d'origine).
  const useWorktree = !!worktree && !id;
  let flags = '';
  if (useWorktree) flags += ' --worktree';
  if (model) flags += ` --model ${model}`;
  if (effort) flags += ` --effort ${effort}`;
  const claudeCmd = `claude${id ? ` --resume ${id}` : ''}${flags}`;
  const base = path.basename(dir).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'session';
  const name = `hooked-${base}-${Date.now().toString(36).slice(-5)}`;

  // `claude` comme commande du shell de login interactif (-ic) : PATH du profil chargé,
  // `exec $SHELL` garde le pane vivant après la sortie de claude.
  const shell = process.env.SHELL || '/bin/zsh';
  const shellCmd = `${shell} -ic '${claudeCmd}; exec ${shell}'`;

  // Taille de la session détachée : sans -x/-y, tmux la crée en 80×24 → TUI claude à l'étroit
  // (24 lignes) dans la vue web. On la crée plus grande (configurable) ; tmux la rétrécit de
  // toute façon à la taille du client réel s'il s'y attache (window-size latest).
  const cols = parseInt(process.env.HOOKED_TMUX_COLS || '', 10) || 120;
  const rows = parseInt(process.env.HOOKED_TMUX_ROWS || '', 10) || 50;

  execFile('tmux', ['new-session', '-d', '-x', String(cols), '-y', String(rows), '-s', name, '-c', dir, shellCmd], (e1) => {
    if (e1) return cb(new Error('tmux new-session a échoué : ' + (e1.message || e1)));
    // mémorise modèle/effort choisis pour pouvoir les afficher sur la session live.
    try {
      fs.appendFileSync(LAUNCHES_FILE, JSON.stringify({ ts: new Date().toISOString(), tmux: name, cwd: dir, model: model || null, effort: effort || null, worktree: useWorktree }) + '\n');
    } catch (_) {}
    // 1er prompt optionnel : best-effort, après un délai pour laisser le TUI claude démarrer.
    // Même piège de détection de collage que deliverReply : on attend ENTER_DELAY (400 ms) après
    // la saisie avant l'Entrée, sinon le texte est tapé mais jamais validé (« envoyé » côté UI,
    // session bloquée sur le 1er message). C'était le cas avec l'ancien délai de 250 ms.
    const seed = prompt && typeof prompt === 'string' ? prompt.trim() : '';
    if (seed) {
      setTimeout(() => execFile('tmux', ['send-keys', '-t', name, '-l', '--', seed], () => {
        setTimeout(() => execFile('tmux', ['send-keys', '-t', name, 'Enter'], () => {}), ENTER_DELAY);
      }), 3500);
    }
    cb(null, { tmux: name, attach: `tmux attach -t ${name}`, cwd: dir, resume: id, worktree: useWorktree });
  });
}

// Stoppe la session : on tue le pane tmux où tourne claude.
function killSession(id, cb) {
  const pane = paneForSession(id);
  if (!pane) return cb(err400('pane tmux inconnu pour cette session (lancée hors tmux ?)'));
  if (!/^%\d+$/.test(pane)) return cb(err400('pane invalide'));
  execFile('tmux', ['kill-pane', '-t', pane], (e) => {
    if (e) return cb(new Error('tmux kill-pane a échoué : ' + (e.message || e)));
    cb(null, { pane });
  });
}

export { paneTmuxNames, invalidatePaneCache, tmuxAlive, launchInfoForPane, resolveLaunchForSession, deliverReply, deliverQuestion, sendKey, parsePaneMode, readPaneMode, readPaneModeSync, setMode, setModelEffort, launchSession, killSession, err400 };
