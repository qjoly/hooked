/*
 * Pilotage tmux : résolution pane→nom de session, livraison de réponses (send-keys),
 * lancement / reprise / arrêt de sessions `claude` interactives (abonnement, zéro conso token).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { LAUNCHES_FILE, SESSION_LAUNCH_FILE, PERMISSION_MODES, LAUNCH_PERMISSION_MODES, isValidModelArg } from './config.js';
import { isValidEffort } from './capabilities.js';
import { statSafe } from './util.js';
import { launchConfigByTmux, paneForSession } from './events.js';
import { scanSessions } from './transcript.js';

// Délai entre la saisie d'un texte et l'Entrée de validation. Le TUI de Claude Code détecte les
// frappes rapprochées comme un *collage* : une Entrée envoyée trop tôt après le texte est avalée
// comme un saut de ligne du collage (texte saisi mais jamais validé — « envoyé » côté UI, session
// bloquée). Il faut laisser la fenêtre de détection de collage se refermer avant de valider.
// Partagé entre deliverReply (réponses) et launchSession (1er prompt) pour rester cohérent.
const ENTER_DELAY = 400;

// Wait for the claude REPL to be ready for input before injecting the first prompt. The TUI takes
// a *variable* time to boot (login shell sourcing the profile + Node startup + MCP connections +
// Ink render): a fixed delay is a lost race on a slow start → the prompt is typed into a shell/
// screen that isn't ready and is lost (session idle, 0 turn). So we poll the pane content until
// the `❯` prompt line appears (input box rendered) — a marker absent from the startup/logo
// screens — then type via deliverReply (the proven path).
const REPL_POLL_INTERVAL = 300;
const REPL_READY_TIMEOUT = 15000;
const REPL_PROMPT_RE = /(^|\n)[ \t]*❯/;
// The AskUserQuestion widget draws its cursor `❯` on the highlighted *numbered option* line
// (e.g. `❯ 1. Red`), which REPL_PROMPT_RE also matches. This narrower pattern detects that
// option-cursor so we can tell "widget still up" from "composer ready" (see waitForQuestionDismissed).
const QUESTION_CURSOR_RE = /(^|\n)[ \t]*❯[ \t]+\d+\./;
// A brand-new / never-trusted cwd triggers Claude Code's trust dialog on first launch ("Quick
// safety check: Is this a project you created or one you trust? … 1. Yes, I trust this folder").
// It's a numbered menu whose `❯ 1. …` cursor ALSO matches REPL_PROMPT_RE, so a plain
// waitForReplReady reports "ready" while it's up and the seed prompt gets typed into the dialog
// (its Enter accepts trust) → folder trusted but the conversation stays empty. Matched on stable
// wording so we can accept it before seeding (see waitForComposerReady).
const TRUST_PROMPT_RE = /Quick safety check|trust (?:the files|this folder)|Do you trust/i;

// True when the pane shows the real REPL composer, ready for a typed message: the `❯` prompt is
// present (REPL_PROMPT_RE) AND it isn't a numbered menu (QUESTION_CURSOR_RE — trust dialog or an
// AskUserQuestion widget). Pure/testable; source of truth shared by the readiness waiters below.
function isComposerReady(screen) {
  const s = String(screen);
  return REPL_PROMPT_RE.test(s) && !QUESTION_CURSOR_RE.test(s);
}

// True when the pane shows Claude Code's "trust this folder?" dialog (see TRUST_PROMPT_RE).
function isTrustPrompt(screen) {
  return TRUST_PROMPT_RE.test(String(screen));
}

// Poll capture-pane until the claude REPL prompt appears (see REPL_PROMPT_RE). `cb(ready)`: true if
// the prompt was detected, false on timeout (the caller then sends anyway, best-effort). Never
// returns an error: this is best-effort seeding.
function waitForReplReady(pane, cb) {
  const deadline = Date.now() + REPL_READY_TIMEOUT;
  const probe = () => {
    execFile('tmux', ['capture-pane', '-t', pane, '-p'], (e, out) => {
      if (!e && REPL_PROMPT_RE.test(out || '')) return cb(true);
      if (Date.now() >= deadline) return cb(false);
      setTimeout(probe, REPL_POLL_INTERVAL);
    });
  };
  probe();
}

// Like waitForReplReady but robust to the trust dialog on a fresh/never-trusted cwd (see
// TRUST_PROMPT_RE): when the dialog is up we accept it (Enter on its default "Yes, I trust this
// folder" option — cursor starts there) instead of typing the seed into it, then keep polling for
// the REAL composer (isComposerReady — `❯` with no numbered-option cursor). Waiting alone would not
// help: nothing else dismisses the dialog, so we'd just time out and then seed into it anyway. Used
// by launchSession before injecting the first prompt. `cb(ready)`: true if the composer appeared,
// false on timeout (caller seeds best-effort). Never errors.
function waitForComposerReady(pane, cb) {
  const deadline = Date.now() + REPL_READY_TIMEOUT;
  let trustAccepted = false;
  const probe = () => {
    execFile('tmux', ['capture-pane', '-t', pane, '-p'], (e, out) => {
      const s = out || '';
      if (!e && !trustAccepted && isTrustPrompt(s) && !isComposerReady(s)) {
        trustAccepted = true; // accept once, then wait for the composer to render
        return execFile('tmux', ['send-keys', '-t', pane, 'Enter'], () => setTimeout(probe, REPL_POLL_INTERVAL));
      }
      if (!e && isComposerReady(s)) return cb(true);
      if (Date.now() >= deadline) return cb(false);
      setTimeout(probe, REPL_POLL_INTERVAL);
    });
  };
  probe();
}

// Poll until a pending AskUserQuestion widget has been dismissed and the composer prompt is back
// (isComposerReady). Plain waitForReplReady is NOT enough here — it matches the `❯` the widget draws
// on its highlighted option, so it reports "ready" while the widget is still up and we'd type into
// it (its Enter then selects the highlighted option). `cb()` fires when dismissed or on timeout.
function waitForQuestionDismissed(pane, cb) {
  const deadline = Date.now() + REPL_READY_TIMEOUT;
  const probe = () => {
    execFile('tmux', ['capture-pane', '-t', pane, '-p'], (e, out) => {
      if (!e && isComposerReady(out || '')) return cb();
      if (Date.now() >= deadline) return cb();
      setTimeout(probe, REPL_POLL_INTERVAL);
    });
  };
  probe();
}

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
  if (!/^%\d+$/.test(pane || '')) return cb(new Error('invalid pane'));
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
//   • CHOIX MULTIPLE : Entrée COCHE/décoche l'option sous le curseur SANS bouger ; il faut → pour
//     passer à l'onglet suivant (question suivante, puis « Submit ») ;
//   • CHOIX UNIQUE : Entrée valide l'option ET passe SEULE à l'onglet suivant → un → en plus
//     SAUTERAIT une question (curseur qui atterrit sur « Submit », frappes suivantes désynchro,
//     mauvaise réponse). Donc PAS de → après une question mono déjà validée par Entrée ;
//   • sur l'onglet « Submit » (curseur déjà sur « Submit answers »), Entrée soumet.
// Donc, par question : descendre jusqu'à chaque option + Entrée ; en multi ajouter → ; après la
// dernière question on est sur « Submit » → Entrée finale.
//
// CRITIQUE : les frappes doivent être largement espacées. Envoyées trop vite (≈90 ms), le TUI
// (ink) les coalesce / en avale — observé : un « ↓↓Entrée » rapproché perdait l'Entrée. ~300 ms
// entre deux touches rend chaque frappe fiable.
// Suite de touches pour UNE question (curseur supposé sur la 1re option de l'écran). Pure/testable.
function questionKeys(q) {
  const keys = [];
  const idx = (q.indices || []).filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  let cur = 0; // position courante du curseur (départ : option 0)
  const targets = q.multi ? idx : (idx.length ? [idx[0]] : []);
  for (const target of targets) {
    for (let k = cur; k < target; k++) keys.push('Down');
    keys.push('Enter'); // coche (multi) ou valide+avance (mono) l'option sous le curseur
    cur = target;
  }
  // → pour l'onglet suivant SEULEMENT si Entrée n'a pas déjà avancé : vrai en choix multiple
  // (Entrée ne fait que cocher), et en choix unique sans sélection (aucun Entrée émis).
  if (q.multi || !targets.length) keys.push('Right');
  return keys;
}

// `selections` : [{ multi: bool, indices: number[] }] (une entrée par question, dans l'ordre).
function deliverQuestion(pane, selections, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  if (!Array.isArray(selections) || !selections.length) return cb(err400('selections required'));
  const KEY_DELAY = 300;     // entre deux touches (ink avale les frappes trop rapprochées)
  const SUBMIT_DELAY = 450;  // avant l'Entrée finale (laisser l'écran « Review » s'afficher)
  const press = (key, done) => execFile('tmux', ['send-keys', '-t', pane, key], (e) => (e ? done(e) : setTimeout(done, KEY_DELAY)));

  const runKeys = (keys, done) => {
    const go = (i) => (i >= keys.length ? done(null) : press(keys[i], (e) => (e ? done(e) : go(i + 1))));
    go(0);
  };

  const stepQuestion = (qi) => {
    if (qi >= selections.length) {
      // sur l'onglet « Submit », curseur sur « Submit answers » → Entrée finale valide tout.
      return setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (e) => cb(e || null)), SUBMIT_DELAY);
    }
    runKeys(questionKeys(selections[qi]), (e) => {
      if (e) return cb(e);
      stepQuestion(qi + 1);
    });
  };
  stepQuestion(0);
}

// Answer an AskUserQuestion via the checkbox/radio navigation (deliverQuestion) THEN, if the user
// attached notes, send them as a follow-up message. Typing free text alone does NOT check the boxes
// on a multi-select prompt (they stay empty and nothing submits), so the structured answer must go
// through deliverQuestion; once it's submitted and the composer is back, the note is queued like any
// message. `note` is optional — without it this is just deliverQuestion.
function deliverQuestionWithNote(pane, selections, note, cb) {
  if (typeof note === 'function') { cb = note; note = ''; }
  deliverQuestion(pane, selections, (err) => {
    if (err) return cb(err);
    const n = typeof note === 'string' ? note.trim() : '';
    if (!n) return cb(null);
    // let the question UI close and the composer come back, then send the note as a follow-up.
    setTimeout(() => waitForReplReady(pane, () => deliverReply(pane, n, false, cb)), 500);
  });
}

// Answer a pending AskUserQuestion with FREE TEXT (the user rejected the offered options and typed
// their own answer). The selection widget swallows typed characters — they navigate options, they
// don't enter text — so we can't type into it. Instead we send Escape to dismiss the
// AskUserQuestion (Claude cancels that tool call and the normal `❯` composer returns), wait for the
// REPL prompt, then deliver the text like any reply (type + single Enter — no "Submit answers"
// confirm; we're back at a normal composer). Reuses waitForReplReady + deliverReply.
function deliverQuestionFreeText(pane, text, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(new Error('invalid pane'));
  execFile('tmux', ['send-keys', '-t', pane, 'Escape'], (err) => {
    if (err) return cb(err);
    // wait for the widget to be gone (not just any `❯`) before typing, else deliverReply's Enter
    // would land on the still-open widget and select its highlighted option.
    waitForQuestionDismissed(pane, () => deliverReply(pane, text, false, cb));
  });
}

// ExitPlanMode approval menu. When Claude calls ExitPlanMode the TUI shows the plan followed by a
// numbered menu ended by "Would you like to proceed?" (labels/order drift across versions — observed
// on v2.1.179):
//   1. Yes, auto-accept edits  (aussi vu : « Yes, and use auto mode »)  -> 'approve-auto'
//   2. Yes, manually approve edits   -> 'approve'
//   3. No, refine with Ultraplan on Claude Code on the web  (deliberately NOT mapped — sends to web)
//   4. Tell Claude what to change    -> 'keep' / 'keep-feedback'
// Selecting option 4 rejects the plan and returns to the composer in plan mode; for 'keep-feedback'
// we then type the feedback like a normal reply. We match the target option by LABEL (never a
// hardcoded index) and navigate from the cursor row (❯) with the same key spacing as deliverQuestion.
const PLAN_ACTIONS = ['approve', 'approve-auto', 'keep', 'keep-feedback'];
const PLAN_OPTION_MATCHERS = {
  // libellé « drifte » selon la version : « auto-accept edits » (v2.1.179) ou « …use auto mode ».
  'approve-auto': /auto[- ](accept|mode)/i,
  'approve': /manually approve/i,
  'keep': /tell claude what to change/i,
  'keep-feedback': /tell claude what to change/i,
};

// Parse the approval menu from a captured screen. Returns the numbered option rows
// [{ num, label, cursor }] when the menu is present (guarded by the "proceed?" header to avoid
// matching other numbered menus like the trust prompt), else null.
function parsePlanPrompt(screen) {
  if (!/would you like to proceed/i.test(String(screen))) return null;
  const opts = [];
  for (const line of String(screen).split('\n')) {
    const m = line.match(/^\s*(❯)?\s*(\d+)\.\s+(.*\S)\s*$/);
    if (m) opts.push({ cursor: !!m[1], num: parseInt(m[2], 10), label: m[3] });
  }
  return opts.length >= 2 ? opts : null;
}

// Drive the ExitPlanMode approval menu. `feedback` is only used (and required) for 'keep-feedback'.
function deliverPlanChoice(pane, action, feedback, cb) {
  if (typeof feedback === 'function') { cb = feedback; feedback = ''; }
  if (!/^%\d+$/.test(pane || '')) return cb(err400('pane invalide'));
  if (!PLAN_ACTIONS.includes(action)) return cb(err400('action inconnue : ' + action));
  const fb = typeof feedback === 'string' ? feedback.trim() : '';
  if (action === 'keep-feedback' && !fb) return cb(err400('feedback requis'));
  execFile('tmux', ['capture-pane', '-t', pane, '-p'], (e, out) => {
    if (e) return cb(e);
    const opts = parsePlanPrompt(out);
    if (!opts) return cb(err400('menu ExitPlanMode absent (plan déjà traité ?)'));
    const target = opts.findIndex((o) => PLAN_OPTION_MATCHERS[action].test(o.label));
    if (target < 0) return cb(new Error(`option introuvable pour l'action « ${action} »`));
    const cur = Math.max(0, opts.findIndex((o) => o.cursor));
    const delta = target - cur;
    const dir = delta >= 0 ? 'Down' : 'Up';
    const KEY_DELAY = 300; // cf. deliverQuestion : ink avale les frappes trop rapprochées
    const press = (k, done) => execFile('tmux', ['send-keys', '-t', pane, k], (er) => (er ? done(er) : setTimeout(done, KEY_DELAY)));
    const nav = (n, done) => (n <= 0 ? done(null) : press(dir, (er) => (er ? done(er) : nav(n - 1, done))));
    nav(Math.abs(delta), (er) => {
      if (er) return cb(er);
      execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (er2) => {
        if (er2) return cb(er2);
        if (action !== 'keep-feedback') return setTimeout(() => cb(null, { pane, action }), 200);
        // option 4 rejette le plan et rouvre le composer (plan mode) : laisser le menu se refermer,
        // attendre l'invite puis envoyer le feedback via le chemin reply éprouvé.
        setTimeout(() => waitForReplReady(pane, () => deliverReply(pane, fb, false, (er3) => cb(er3 || null, { pane, action }))), 500);
      });
    });
  });
}

// Envoie une touche « nommée » (ex. Escape) au pane : sert à interrompre Claude depuis l'UI,
// exactement comme une frappe Echap dans le TUI interactif.
function sendKey(pane, key, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  if (!/^[A-Za-z0-9]+$/.test(key || '')) return cb(err400('invalid key'));
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
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  execFile('tmux', ['capture-pane', '-t', pane, '-p'], (e, out) => {
    if (e) return cb(e);
    cb(null, parsePaneMode(out));
  });
}

// Capture synchrone du texte du pane, mise en cache ~2,5 s. La liste des sessions se rafraîchit
// toutes les 5 s et interroge le mode ET l'occupation de chaque pane vivant → le cache évite de
// doubler les `capture-pane` (détail + liste rapprochés) et borne le coût. Timeout court : tmux
// local répond en général en <50 ms.
const _paneTextCache = new Map(); // pane -> { ts, text }
function capturePaneTextSync(pane, ttl = 2500) {
  if (!/^%\d+$/.test(pane || '')) return null;
  const c = _paneTextCache.get(pane);
  const now = Date.now();
  if (c && now - c.ts < ttl) return c.text;
  let text = null;
  try { text = execFileSync('tmux', ['capture-pane', '-t', pane, '-p'], { encoding: 'utf8', timeout: 800 }); }
  catch (_) { text = null; }
  _paneTextCache.set(pane, { ts: now, text });
  return text;
}

// Corps STABLE de la conversation : le texte capturé PRIVÉ de sa zone d'invite + footer (tout ce qui
// se trouve à partir de la dernière ligne d'invite ❯ incluse — boîte de saisie, ligne de mode
// « ⏵⏵ … (shift+tab to cycle) », lignes de sous-agents « ○ … »). C'est la partie qui NE bouge PAS
// quand le pane est au repos : le footer, lui, « respire » entre deux captures (tips qui tournent,
// curseur, compteur) même sur un pane idle → le comparer ferait passer un pane inactif pour actif.
// À l'inverse, pendant que Claude STREAME sa réponse finale (busy=false, pas de spinner), c'est
// justement ce corps qui grandit → le signal fiable « en train d'écrire vs terminé ». Cf. paneActiveSync.
// Fallback sans invite ❯ (écran plein, menu…) : tout le texte moins les lignes vides de queue.
function conversationBody(text) {
  const lines = String(text).split('\n');
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) { if (/^[ \t]*❯/.test(lines[i])) { end = i; break; } }
  const body = lines.slice(0, end);
  // rogner les lignes de queue vides / de bordure de boîte (statiques mais bruit) pour comparer net.
  while (body.length && /^[ \t]*[╭╮╰╯─│▁▔]*[ \t]*$/.test(body[body.length - 1])) body.pop();
  return body.join('\n');
}

// Décision pure de l'activité du corps : à partir de l'entrée précédente, de l'ESTAMPILLE de capture
// (`stamp` = ts de la lecture tmux, cf. _paneTextCache) et du texte courant, renvoie la nouvelle entrée
// { stamp, body, active }. `active` = le corps a-t-il changé depuis le tick précédent ? true = il bouge
// (Claude écrit / mouline), false = statique (tour terminé). Première observation : pas de référence →
// `true` (actif) par prudence, pour ne JAMAIS rétrograder un tour en cours faute de recul ; le tick
// suivant tranche pour de bon.
//
// La dédup « même tick » se fait sur `stamp`, PAS sur le texte : deux appels au MÊME tick (liste +
// détail) relisent la MÊME capture en cache (capturePaneTextSync, TTL 2,5 s) → même ts → même verdict
// stable (sinon le 2ᵉ appel comparerait le corps à lui-même et conclurait « statique » à tort). Une
// nouvelle capture FRAÎCHE (tick suivant) a toujours un ts neuf, MÊME si ses octets sont identiques —
// ce qui arrive dès que le footer ne « respire » pas (Claude Code récent : pane idle = capture figée
// bit-à-bit). Clé sur le texte, cette égalité rejouait éternellement le `active=true` de la 1re
// observation → la session finie restait 'working' à vie (bug « working après tour fini » que la
// démotion de refineWithPane était justement censée rattraper). Clé sur `stamp`, un pane figé retombe
// bien à active=false au tick suivant.
function paneActiveStep(prev, stamp, text) {
  if (prev && prev.stamp === stamp) return prev; // même capture (même tick) → entrée inchangée
  const body = conversationBody(text);
  const active = prev ? body !== prev.body : true; // 1re observation : pas de référence → actif par prudence
  return { stamp, body, active };
}

const _paneBodyCache = new Map(); // pane -> { stamp, body, active }
function paneActiveSync(pane) {
  const text = capturePaneTextSync(pane);
  if (text == null) return null;
  const c = _paneTextCache.get(pane);
  const stamp = c ? c.ts : null; // ts de la capture : neuf à chaque lecture fraîche, stable sur cache-hit
  const next = paneActiveStep(_paneBodyCache.get(pane), stamp, text);
  _paneBodyCache.set(pane, next);
  return next.active;
}

// Purge les caches pane (liste des panes + texte capturé + corps observé) → la prochaine dérivation
// d'état relit tmux à froid (liveness + footer + détection de changement), sans attendre l'expiration
// des caches 2,5–3 s. Utilisé par le resync manuel des Réglages pour débloquer une session périmée.
function clearPaneCaches() { paneNameCache.at = 0; _paneTextCache.clear(); _paneBodyCache.clear(); }

// Lecture synchrone du mode (pour enrichir le détail de session sans casser son API synchrone).
function readPaneModeSync(pane) {
  const text = capturePaneTextSync(pane);
  return text == null ? null : parsePaneMode(text);
}

// Spinner d'activité de Claude Code. Quand il traite (réflexion OU outil en cours), le TUI peint
// dans son footer une ligne « <glyphe> <Gérondif>… (<temps> · ↓ <tokens>) », p. ex.
// « ✻ Accomplishing… (3m 25s · ↓ 11.3k tokens) ». Le glyphe s'anime (✻ ✽ ✶ ✢ ✳ ·) et le gérondif
// (Accomplishing / Clauding / Gibberishing / …) est tiré au sort — c'est le petit mot « pensant »
// qu'on veut remonter dans l'UI. On NE liste PAS les gérondifs (arbitraires, changés au fil des
// versions) : on extrait le mot situé entre le glyphe et l'ellipsis.
//
// Ancrage STRICT pour ne jamais confondre avec du texte de conversation ou une sortie d'outil. La
// ligne doit commencer (après une éventuelle indentation) par un GLYPHE DE SPINNER — un des symboles
// « étoile » que l'animation fait défiler (✻ ✽ ✶ ✢ ✳ …) ou le point médian « · », jamais utilisés
// comme puce markdown (`* `, `• `, `- `) ni comme préfixe de sortie d'outil (`⎿`) ou de blockquote
// (`▎`) — puis un espace, le mot (lettres ASCII, espaces, ' et - seulement), l'ellipsis (« … » ou
// « ... »), puis « ( » (début du compteur temps/tokens). Une ligne de prose citant « …/Cogitating…/… »
// ou « ⎿ Running tests… (12s) » d'une sortie d'outil n'a donc pas cette forme et ne matche pas.
//
// Recherche BORNÉE AU FOOTER : le spinner est peint juste au-dessus de la boîte de saisie (❯), jamais
// dans le corps de la conversation. On ne balaie donc que les ~14 lignes situées au-dessus de la
// dernière invite ❯ — sinon un spinner CITÉ dans un message (ex. une session qui parle du spinner)
// serait pris pour un vrai → faux « working » quand la session est en fait à l'arrêt. Dernier match
// dans la fenêtre = le plus proche de l'invite (le vrai spinner, s'il y a aussi une citation juste
// au-dessus). Vérifié en live : footer « ✻ Accomplishing… (3m 25s · ↓ 11.3k tokens) ».
// Le glyphe de tête = un glyphe « étoile/sparkle » du CYCLE d'animation : le spinner anime son glyphe
// et cycle sur ✻ ✽ ✶ ✢ · et « * » (astérisque, U+002A). On matche donc TOUT le bloc dingbat-étoiles
// (U+2722–U+273D) + « * » + « · » plutôt qu'une liste figée (source du bug : « * » manquait → ~1 frame
// sur 6 ratée → état clignotant working↔waiting), en EXCLUANT les préfixes de sortie d'outil (⎿ U+23BF,
// ● U+25CF) et de todo (✔ ◻…) — pas des spinners. La forme « …(durée » + le bornage au footer écartent
// une citation ; le format fini « <glyphe> Verbe for <durée> » (sans …/() reste rejeté.
// Libellé capturé = une lettre puis TOUT sauf « ( … \n » : Claude Code affiche parfois la TODO en
// cours comme libellé (ex. « Recreating talos-mono for IDEM-4/5 » — chiffres, « / »…), pas seulement
// un gérondif → on ne le restreint PAS aux lettres/espaces (sinon un chiffre coupe le match avant le
// « … » → spinner non détecté → busy=false → session affichée « background » alors qu'elle mouline).
const SPINNER_RE = /^[ \t]*[*·✢-✽][ \t]+([A-Za-z][^(…\n]{0,80}?)(?:…|\.\.\.)[ \t]*\(/;
const SPINNER_FOOTER_SPAN = 14;
function parseSpinner(screen) {
  const lines = String(screen).split('\n');
  // borne haute = la dernière ligne d'invite ❯ (le spinner est au-dessus) ; à défaut, fin d'écran.
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) { if (/^[ \t]*❯/.test(lines[i])) { end = i; break; } }
  let word = null;
  for (let i = Math.max(0, end - SPINNER_FOOTER_SPAN); i < end; i++) {
    const m = SPINNER_RE.exec(lines[i]);
    if (m) word = m[1].trim();
  }
  return word;
}

// Claude « mouline »-t-il ? Deux signaux possibles dans le footer : la ligne spinner d'activité
// (cf. parseSpinner) et — selon les versions — « esc to interrupt ». Présence de l'un ⇒ working ;
// absence des deux (boîte de saisie seule) ⇒ en attente. true / false / null (pane injoignable → on
// ne tranche pas, on garde l'état déduit des hooks). NB : sur Claude Code récent le footer n'affiche
// PLUS « esc to interrupt » pendant le travail (vérifié en live) → la ligne spinner est le signal
// fiable ; « esc to interrupt » reste en secours pour d'autres versions/écrans.
function paneBusySync(pane) {
  const text = capturePaneTextSync(pane);
  if (text == null) return null;
  return parseSpinner(text) != null || /esc to interrupt/i.test(text);
}

// Verbe d'activité courant (« Accomplishing », « Clauding »…) affiché par le spinner du TUI, ou null
// si Claude ne mouline pas / pane injoignable. Réutilise le cache de capture (paneBusySync l'a déjà
// peuplé au même tick) → pas de `capture-pane` supplémentaire.
function paneActivitySync(pane) {
  const text = capturePaneTextSync(pane);
  if (text == null) return null;
  return parseSpinner(text);
}

// Change le mode de permission d'une session live en BOUCLE FERMÉE : on lit le mode affiché,
// et tant qu'il diffère de la cible on envoie un Maj+Tab (`BTab`) puis on relit le footer.
// Robuste à n'importe quel ordre/longueur de cycle (l'ordre réel observé est
// default → acceptEdits → plan → auto → …, mais on ne s'y fie pas), et auto-vérifié.
function setMode(pane, target, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  if (!PERMISSION_MODES.includes(target)) return cb(err400('unknown mode: ' + target));
  const MAX = 6; // garde-fou : au plus 6 modes dans le cycle → jamais de boucle infinie
  const step = (n) => {
    readPaneMode(pane, (e, cur) => {
      if (e) return cb(e);
      if (cur === target) return cb(null, { pane, mode: target, presses: n });
      if (n >= MAX) return cb(new Error(`mode "${target}" not reached after ${n} Shift+Tab (current mode: ${cur})`));
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
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  if (model && !isValidModelArg(model)) return cb(err400('unknown model: ' + model));
  if (effort && !isValidEffort(effort)) return cb(err400('unknown effort: ' + effort));
  if (!model && !effort) return cb(err400('model or effort required'));
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
function launchSession({ resumeId, cwd, prompt, model, effort, worktree, permissionMode }, cb) {
  let dir = cwd && typeof cwd === 'string' ? cwd : null;
  let id = null;
  if (resumeId) {
    if (!/^[A-Za-z0-9._-]+$/.test(resumeId)) return cb(err400('invalid session id'));
    const sess = scanSessions().find((s) => s.id === resumeId);
    if (!sess) return cb(err400('session not found'));
    dir = dir || sess.project; // on reprend dans le dossier d'origine de la session
    id = resumeId;
  }
  if (!dir) return cb(err400('directory (cwd) required'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('invalid cwd: ' + dir));

  // model/effort : validés contre une liste blanche (sécurise l'injection shell ET rejette l'inconnu).
  if (model && !isValidModelArg(model)) return cb(err400('unknown model: ' + model));
  if (effort && !isValidEffort(effort)) return cb(err400('unknown effort: ' + effort));
  if (permissionMode && !LAUNCH_PERMISSION_MODES.includes(permissionMode)) return cb(err400('unknown permission mode: ' + permissionMode));
  // worktree : sans objet sur une reprise (la session est rouverte dans son dossier d'origine).
  const useWorktree = !!worktree && !id;
  let flags = '';
  if (useWorktree) flags += ' --worktree';
  if (model) flags += ` --model ${model}`;
  if (effort) flags += ` --effort ${effort}`;
  // 'default' = comportement natif → pas de flag (commande propre) ; sinon on épingle le mode.
  if (permissionMode && permissionMode !== 'default') flags += ` --permission-mode ${permissionMode}`;
  const claudeCmd = `claude${id ? ` --resume ${id}` : ''}${flags}`;
  const base = path.basename(dir).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'session';
  const name = `hooked-${base}-${Date.now().toString(36).slice(-5)}`;

  // On lance `claude` dans un shell de LOGIN interactif. `-l` fait sourcer les fichiers de login
  // du shell (profil utilisateur) EN PLUS des fichiers interactifs : c'est là que les package
  // managers (brew, asdf, nvm…) publient leur PATH. Sans `-l`, un hooked démarré avec un PATH
  // minimal (service systemd, cron, launchd…) ne retrouve pas `claude` → session morte.
  // Flags séparés `-l -i -c` : portables sur sh/bash/zsh/fish (le groupé `-lic` ne l'est pas).
  // `exec $SHELL` garde le pane vivant après la sortie de claude. SHELL décidé par l'utilisateur.
  const shell = process.env.SHELL || '/bin/zsh';
  const shellCmd = `${shell} -l -i -c '${claudeCmd}; exec ${shell}'`;

  // Taille de la session détachée : sans -x/-y, tmux la crée en 80×24 → TUI claude à l'étroit
  // (24 lignes) dans la vue web. On la crée plus grande (configurable) ; tmux la rétrécit de
  // toute façon à la taille du client réel s'il s'y attache (window-size latest).
  const cols = parseInt(process.env.HOOKED_TMUX_COLS || '', 10) || 120;
  const rows = parseInt(process.env.HOOKED_TMUX_ROWS || '', 10) || 64;

  execFile('tmux', ['new-session', '-d', '-x', String(cols), '-y', String(rows), '-s', name, '-c', dir, shellCmd], (e1) => {
    if (e1) return cb(new Error('tmux new-session failed: ' + (e1.message || e1)));
    // mémorise modèle/effort choisis pour pouvoir les afficher sur la session live.
    try {
      fs.appendFileSync(LAUNCHES_FILE, JSON.stringify({ ts: new Date().toISOString(), tmux: name, cwd: dir, model: model || null, effort: effort || null, worktree: useWorktree }) + '\n');
    } catch (_) {}
    // Optional first prompt: best-effort, IN THE BACKGROUND (we return right away via the cb below,
    // without waiting for the TUI to boot). Resolve the session's pane, wait for the composer to be
    // ready (waitForComposerReady — which also accepts the trust dialog on a fresh/never-trusted cwd,
    // otherwise the seed is typed into that dialog and lost), then inject the prompt via deliverReply
    // — exactly the reply path's mechanism (send-keys -l + Enter after ENTER_DELAY, which lets the
    // paste-detection window close before validating). A fixed delay wasn't enough: on a slow start
    // the prompt was typed into a TUI that wasn't ready and lost.
    const seed = prompt && typeof prompt === 'string' ? prompt.trim() : '';
    if (seed) {
      execFile('tmux', ['display-message', '-p', '-t', name, '#{pane_id}'], (ePane, paneOut) => {
        const pane = (paneOut || '').trim();
        if (ePane || !/^%\d+$/.test(pane)) return; // pane not resolved: drop the seed (best-effort)
        waitForComposerReady(pane, () => deliverReply(pane, seed, false, () => {}));
      });
    }
    // NB: no `link` field here — at launch the real session id isn't known yet (id is null for a
    // fresh start), so a deep-link would be `/session/null`. `get_session` returns the correct link.
    cb(null, { tmux: name, attach: `tmux attach -t ${name}`, cwd: dir, resume: id, worktree: useWorktree });
  });
}

// Stoppe la session : on tue le pane tmux où tourne claude.
function killSession(id, cb) {
  const pane = paneForSession(id);
  if (!pane) return cb(err400('unknown tmux pane for this session (launched outside tmux?)'));
  if (!/^%\d+$/.test(pane)) return cb(err400('invalid pane'));
  execFile('tmux', ['kill-pane', '-t', pane], (e) => {
    if (e) return cb(new Error('tmux kill-pane failed: ' + (e.message || e)));
    cb(null, { pane });
  });
}

// Redémarre une session pour qu'elle reparte sur la version claude installée : on tue le pane où
// tourne l'ancien process, puis on relance `claude --resume <id>` dans une NOUVELLE session tmux
// détachée (launchSession). L'état en mémoire est volontairement perdu ; la reprise recharge le
// transcript (cf. philosophie « reconnect » du projet). model/effort sont ré-épinglés à la reprise.
// hooked resuit la session par son id : `paneForSession` la retrouve via les nouveaux évènements.
function restartSession(id, { model, effort } = {}, cb) {
  const pane = paneForSession(id);
  const relaunch = () => launchSession({ resumeId: id, model, effort }, cb);
  // Pane encore vivant → on le tue d'abord ; sinon (déjà fermé) on enchaîne directement sur la reprise.
  if (pane && /^%\d+$/.test(pane) && tmuxAlive(pane)) {
    execFile('tmux', ['kill-pane', '-t', pane], () => relaunch()); // erreur ignorée : le pane a pu mourir entre-temps
  } else {
    relaunch();
  }
}

export { paneTmuxNames, invalidatePaneCache, clearPaneCaches, tmuxAlive, launchInfoForPane, resolveLaunchForSession, deliverReply, deliverQuestion, questionKeys, deliverQuestionWithNote, deliverQuestionFreeText, deliverPlanChoice, parsePlanPrompt, isTrustPrompt, isComposerReady, sendKey, parsePaneMode, readPaneMode, readPaneModeSync, paneBusySync, parseSpinner, paneActivitySync, conversationBody, paneActiveSync, paneActiveStep, setMode, setModelEffort, launchSession, killSession, restartSession, err400 };
