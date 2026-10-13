/*
 * Threads de revue — la conversation GitHub-style ancrée dans la diff (lentilles Ship / Branch).
 *
 * Un thread = une ancre (file, side, start–end, snippet) + une suite de messages
 * { author: 'user'|'claude', text, ts }. Il naît d'un commentaire utilisateur (état « pending »,
 * batché), part vers Claude en lot (`sent`), puis la conversation continue dans le thread :
 * l'utilisateur répond depuis la diff (envoi immédiat), Claude répond via l'outil MCP
 * `reply_review_comment`.
 *
 * CLORE EST LA DÉCISION DU RELECTEUR, JAMAIS CELLE DE CLAUDE. Les instructions envoyées avec le
 * lot demandaient à Claude d'appeler `resolve_review_comment` « once the code is fixed » : chaque
 * réponse fermait donc le thread aussitôt, et la diff se vidait des commentaires avant même
 * qu'on ait lu les réponses. L'outil MCP a été retiré et l'état s'appelle maintenant `archived` :
 * un thread archivé quitte la diff et rejoint la liste dépliante des archives.
 *
 * `status` vaut 'open' | 'archived'. Les fichiers écrits avant ce changement portent 'resolved',
 * relu comme 'archived' au chargement (readThreads) — une revue déjà traitée arrive donc rangée,
 * sans script de migration.
 *
 * Persistance : un JSON par session sous HOOKED_DIR/reviews/ — côté serveur (et plus
 * localStorage) parce que Claude doit pouvoir y écrire et que tous les navigateurs doivent
 * voir les mêmes threads. Le brouillon localStorage ne garde que les ticks « reviewed ».
 *
 * `opIndex` est la clé de section de diff du front (vue Claude / commit / branche) : opaque ici,
 * elle sert seulement à re-render le thread sous la bonne section.
 *
 * Threads opened by Claude ("Review with Claude"): the lens first records the scope the review
 * was asked on (`startReview`, stored next to the threads as `review.scope`), then Claude opens
 * one thread per finding (`addClaudeThread`, MCP `add_review_comment`). Claude only gives a path
 * and line numbers; the snippet is read here, because reanchor() needs the exact lines and a model
 * does not copy them byte for byte. It is read through symbols.readSlice: the same confinement as
 * /api/session/source (realpath, repositories of the session project only — these lines end up
 * served by GET /api/review), and the revision the diff's new side comes from (`review.rev`: the
 * branch tip or the end of a commit slice; none for the working tree and the session scope).
 * Such a thread is born `sent`: it is already in Claude's context, there is no batch to wait for,
 * and the reviewer can reply at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOOKED_DIR } from './config.js';
import { readSlice } from './symbols.js';

const REVIEWS_DIR = path.join(HOOKED_DIR, 'reviews');
const MAX_THREADS = 200;    // par session
const MAX_MESSAGES = 50;    // par thread
const MAX_TEXT = 20000;     // par message
const MAX_SNIPPET = 4000;
const MAX_CLAUDE_SPAN = 30;  // lines a Claude-opened thread may cover
// Where a Claude thread goes when no review was started from the lens (Claude asked in the chat):
// the working tree, i.e. the current changes — the front's key for "any section of that scope".
const DEFAULT_SCOPE = 'vcs:wt:*';

// Un id de session est un uuid (ou proche) : jamais de séparateur de chemin dans le nom de fichier.
const SID_RE = /^[A-Za-z0-9._-]+$/;
const fileFor = (sessionId) => path.join(REVIEWS_DIR, sessionId + '.json');

// 'resolved' est l'ancien nom d'`archived` : normalisé ici, à l'entrée, pour que le reste du
// code (et le front) n'ait qu'un seul vocabulaire à connaître.
const normalize = (t) => (t && t.status === 'resolved' ? { ...t, status: 'archived' } : t);

// The session's review file: its threads, plus the scope of the last review asked to Claude.
function readDoc(sessionId) {
  if (!sessionId || !SID_RE.test(sessionId)) return { threads: [], review: null };
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sessionId), 'utf8'));
    return {
      threads: Array.isArray(raw?.threads) ? raw.threads.map(normalize) : [],
      review: raw?.review && typeof raw.review.scope === 'string' ? raw.review : null,
    };
  } catch (_) {
    return { threads: [], review: null };
  }
}

const readThreads = (sessionId) => readDoc(sessionId).threads;

// Rewrites the threads and keeps the stored review scope.
function writeThreads(sessionId, threads) {
  writeDoc(sessionId, { ...readDoc(sessionId), threads });
}

function writeDoc(sessionId, doc) {
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(sessionId), JSON.stringify(doc, null, 2));
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

// Réponse dans un thread. `author` est borné à user/claude. Une réponse de l'UTILISATEUR
// désarchive (comme GitHub : relancer la discussion la remet à l'écran) ; une réponse de Claude
// ne ressort JAMAIS un thread rangé — c'est tout l'objet du changement.
function replyThread(sessionId, threadId, author, text) {
  const clean = cleanText(text);
  if (!clean || (author !== 'user' && author !== 'claude')) return null;
  const threads = readThreads(sessionId);
  const t = threads.find((x) => x.id === threadId);
  if (!t || t.messages.length >= MAX_MESSAGES) return null;
  t.messages.push({ author, text: clean, ts: new Date().toISOString() });
  if (author === 'user' && t.status === 'archived') t.status = 'open';
  writeThreads(sessionId, threads);
  return t;
}

// Editing is for PENDING threads only: once the batch went out, the text is in Claude's context —
// rewriting it here would make the stored thread lie about what was actually sent. A pending
// thread has exactly one message (replies only exist on sent threads), so the edit rewrites the
// opening message and leaves the anchor untouched.
function editThread(sessionId, threadId, text) {
  const clean = cleanText(text);
  if (!clean) return null;
  const threads = readThreads(sessionId);
  const t = threads.find((x) => x.id === threadId);
  if (!t || t.sent) return null;
  t.messages[0] = { ...t.messages[0], text: clean };
  writeThreads(sessionId, threads);
  return t;
}

// Archivage / restauration. Un thread archivé n'est plus rendu dans la diff (le front ne le
// passe plus à DiffView) : il vit dans la liste des archives, restaurable.
function archiveThread(sessionId, threadId, archived = true) {
  const threads = readThreads(sessionId);
  const t = threads.find((x) => x.id === threadId);
  if (!t) return null;
  t.status = archived ? 'archived' : 'open';
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

// A review was asked to Claude on `scope` (the front's section key for that whole scope), whose
// new side comes from revision `rev` (none: the file on disk): the threads Claude opens from now
// on are filed under that scope and anchored at that revision.
function startReview(sessionId, scope, rev = null) {
  if (!sessionId || !SID_RE.test(sessionId) || typeof scope !== 'string' || !scope) return null;
  const review = {
    scope: scope.slice(0, 400),
    rev: typeof rev === 'string' && rev ? rev.slice(0, 200) : null,
    at: new Date().toISOString(),
  };
  writeDoc(sessionId, { ...readDoc(sessionId), review });
  return review;
}

// Claude opens a thread on lines `start`–`end` (1-based, `end` defaults to `start`) of `file` as the
// diff's new side shows it. `cwd` (the session's project) resolves a relative path and bounds what
// may be read. Resolves to { thread } or { error }: the caller is a model, and a precise refusal
// lets it fix its call.
async function addClaudeThread(sessionId, input, cwd) {
  if (!sessionId || !SID_RE.test(sessionId)) return { error: 'invalid session id' };
  const text = cleanText(input?.text);
  if (!text) return { error: 'text is required' };
  const start = input.start;
  if (!Number.isInteger(start) || start < 1) return { error: 'line must be a positive integer' };
  if (typeof input.file !== 'string' || !input.file) return { error: 'file is required' };
  if (!cwd) return { error: 'unknown session project' };
  const file = path.resolve(cwd, input.file);
  const wanted = Number.isInteger(input.end) && input.end >= start ? input.end : start;
  const span = { file, from: start, to: Math.min(wanted, start + MAX_CLAUDE_SPAN - 1) };
  const rev = readDoc(sessionId).review?.rev || '';
  let slice = await readSlice(cwd, { ...span, rev });
  // A revision that no longer resolves (branch deleted, jj-only repo) still leaves the file on disk.
  if (!slice.supported && rev) slice = await readSlice(cwd, span);
  if (!slice.supported) return { error: `cannot read ${file}: missing, binary, or outside the session's repositories` };
  if (start > slice.total) return { error: `line ${start} is past the end of ${file} (${slice.total} lines)` };
  // Whole lines or nothing: reanchor() compares line by line, so a line cut short would leave the
  // thread outdated forever, while a thread without a snippet simply keeps its anchor.
  const snippet = slice.lines.join('\n');
  // Read again: the await above let other writes in.
  const doc = readDoc(sessionId);
  if (doc.threads.length >= MAX_THREADS) return { error: `this review already holds ${MAX_THREADS} threads` };
  const thread = {
    id: crypto.randomUUID(),
    file,
    name: path.basename(file),
    opIndex: doc.review?.scope || DEFAULT_SCOPE,
    side: 'new', start, end: slice.to,
    snippet: snippet.length <= MAX_SNIPPET ? snippet : '',
    status: 'open',
    sent: true,
    messages: [{ author: 'claude', text, ts: new Date().toISOString() }],
  };
  writeDoc(sessionId, { ...doc, threads: [...doc.threads, thread] });
  return { thread };
}

export { listThreads, addThread, deleteThread, editThread, replyThread, archiveThread, markThreadsSent, startReview, addClaudeThread };
