/*
 * Threads de revue — la conversation GitHub-style ancrée dans la diff (lentilles Ship / Branch).
 *
 * Un thread = une ancre (file, side, start–end, snippet) + une suite de messages
 * { author: 'user'|'claude', text, ts }. Il naît d'un commentaire utilisateur (état « pending »,
 * batché), part vers Claude en lot (`sent`), puis la conversation continue dans le thread :
 * l'utilisateur répond depuis la diff (envoi immédiat), Claude répond via l'outil MCP
 * `reply_review_comment` et clôt via `resolve_review_comment`.
 *
 * Persistance : un JSON par session sous HOOKED_DIR/reviews/ — côté serveur (et plus
 * localStorage) parce que Claude doit pouvoir y écrire et que tous les navigateurs doivent
 * voir les mêmes threads. Le brouillon localStorage ne garde que les ticks « reviewed ».
 *
 * `opIndex` est la clé de section de diff du front (vue Claude / commit / branche) : opaque ici,
 * elle sert seulement à re-render le thread sous la bonne section.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOOKED_DIR } from './config.js';

const REVIEWS_DIR = path.join(HOOKED_DIR, 'reviews');
const MAX_THREADS = 200;    // par session
const MAX_MESSAGES = 50;    // par thread
const MAX_TEXT = 20000;     // par message
const MAX_SNIPPET = 4000;

// Un id de session est un uuid (ou proche) : jamais de séparateur de chemin dans le nom de fichier.
const SID_RE = /^[A-Za-z0-9._-]+$/;
const fileFor = (sessionId) => path.join(REVIEWS_DIR, sessionId + '.json');

function readThreads(sessionId) {
  if (!sessionId || !SID_RE.test(sessionId)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sessionId), 'utf8'));
    return Array.isArray(raw?.threads) ? raw.threads : [];
  } catch (_) {
    return [];
  }
}

function writeThreads(sessionId, threads) {
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(sessionId), JSON.stringify({ threads }, null, 2));
}

const cleanText = (t) => (typeof t === 'string' ? t.trim().slice(0, MAX_TEXT) : '');

function listThreads(sessionId) {
  return readThreads(sessionId);
}

// Nouveau commentaire → nouveau thread « pending » (non envoyé). Renvoie le thread, ou null si
// l'entrée est invalide.
function addThread(sessionId, input) {
  if (!sessionId || !SID_RE.test(sessionId) || !input || typeof input !== 'object') return null;
  const text = cleanText(input.text);
  const file = typeof input.file === 'string' ? input.file : '';
  const side = input.side === 'old' ? 'old' : 'new';
  const start = Number.isInteger(input.start) && input.start > 0 ? input.start : null;
  const end = Number.isInteger(input.end) && input.end >= (start || 1) ? input.end : start;
  if (!text || !file || !start) return null;
  const threads = readThreads(sessionId);
  if (threads.length >= MAX_THREADS) return null;
  const now = new Date().toISOString();
  const thread = {
    id: crypto.randomUUID(),
    file,
    name: typeof input.name === 'string' ? input.name.slice(0, 200) : path.basename(file),
    opIndex: typeof input.opIndex === 'string' ? input.opIndex.slice(0, 200) : '',
    side, start, end,
    snippet: typeof input.snippet === 'string' ? input.snippet.slice(0, MAX_SNIPPET) : '',
    status: 'open',
    sent: false,
    messages: [{ author: 'user', text, ts: now }],
  };
  writeThreads(sessionId, [...threads, thread]);
  return thread;
}

// Suppression : n'importe quel thread, envoyé ou non. La règle précédente (« après envoi c'est
// une conversation, on la résout, on ne l'efface pas ») rendait la liste de commentaires du
// panneau Ship / Branch trompeuse : elle montre TOUS les threads, la corbeille échouait
// silencieusement sur les envoyés et le rafraîchissement les faisait réapparaître. Effacer une
// conversation reste destructeur — c'est l'UI qui garde le garde-fou (confirmation en deux
// temps), le store, lui, obéit.
function deleteThread(sessionId, threadId) {
  const threads = readThreads(sessionId);
  const t = threads.find((x) => x.id === threadId);
  if (!t) return false;
  writeThreads(sessionId, threads.filter((x) => x.id !== threadId));
  return true;
}

// Réponse dans un thread. `author` est borné à user/claude ; répondre rouvre un thread résolu
// (comme GitHub : une réponse sur un thread clos le remet en discussion).
function replyThread(sessionId, threadId, author, text) {
  const clean = cleanText(text);
  if (!clean || (author !== 'user' && author !== 'claude')) return null;
  const threads = readThreads(sessionId);
  const t = threads.find((x) => x.id === threadId);
  if (!t || t.messages.length >= MAX_MESSAGES) return null;
  t.messages.push({ author, text: clean, ts: new Date().toISOString() });
  if (author === 'user' && t.status === 'resolved') t.status = 'open';
  writeThreads(sessionId, threads);
  return t;
}

function resolveThread(sessionId, threadId, resolved = true) {
  const threads = readThreads(sessionId);
  const t = threads.find((x) => x.id === threadId);
  if (!t) return null;
  t.status = resolved ? 'resolved' : 'open';
  writeThreads(sessionId, threads);
  return t;
}

// Le lot part vers Claude : marque ces threads envoyés (ils quittent le « pending » du front).
function markThreadsSent(sessionId, ids) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  const threads = readThreads(sessionId);
  let n = 0;
  for (const t of threads) if (set.has(t.id) && !t.sent) { t.sent = true; n++; }
  if (n) writeThreads(sessionId, threads);
  return n;
}

export { listThreads, addThread, deleteThread, replyThread, resolveThread, markThreadsSent };
