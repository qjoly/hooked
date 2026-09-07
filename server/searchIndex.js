/*
 * Index FTS5 plein-texte des messages user/assistant (Claude prose), bâti en LAZY :
 * la DB est ouverte au premier appel, et chaque appel à `search()` re-scanne
 * brièvement les transcripts pour ré-indexer ceux dont le mtime a changé.
 *
 * - Stockage : `~/.claude/hooked/search.db` (override : HOOKED_SEARCH_DB).
 * - Aucune dépendance externe : `node:sqlite` (stable depuis Node 24).
 * - Outils ignorés : on n'indexe que la `text` retournée par buildConversation()
 *   (= prompts user + prose assistant), sans tool_use / tool_result.
 * - Schéma external-content FTS5 : table `messages` + virtual `messages_fts`
 *   synchronisée par triggers → un seul write par message, un seul scan par token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// `node:sqlite` est un module natif Node 24+. On le charge via createRequire pour que
// le résolveur de Vite ne tente pas de le transformer (sinon : "Failed to load url sqlite").
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { HOOKED_DIR, PROJECTS_DIR } from './config.js';
import { scanSessions } from './transcript.js';
import { buildConversation } from './conversation.js';

let db = null;
let dbPath = null;

function dbFile() {
  return process.env.HOOKED_SEARCH_DB || path.join(HOOKED_DIR, 'search.db');
}

function open() {
  const target = dbFile();
  if (db && dbPath === target) return db;
  if (db) { try { db.close(); } catch (_) {} db = null; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  dbPath = target;
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS sessions (
      file TEXT PRIMARY KEY,
      session_id TEXT,
      project TEXT,
      mtime INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      file TEXT NOT NULL,
      session_id TEXT,
      project TEXT,
      role TEXT,
      ts TEXT,
      text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_file ON messages(file);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
  `);
  return db;
}

// Indexe (ou ré-indexe) un transcript. Idempotent : supprime les anciennes lignes
// pour ce fichier avant insertion. Renvoie le nombre de messages insérés.
function indexFile(d, sum, mtimeMs) {
  const msgs = buildConversation(sum.file, false);
  const del = d.prepare('DELETE FROM messages WHERE file = ?');
  del.run(sum.file);
  const ins = d.prepare(
    'INSERT INTO messages (file, session_id, project, role, ts, text) VALUES (?, ?, ?, ?, ?, ?)'
  );
  let n = 0;
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = (m.text || '').trim();
    if (!text) continue;
    ins.run(sum.file, sum.id, sum.project || '', m.role, m.ts || '', text);
    n++;
  }
  const up = d.prepare(
    'INSERT INTO sessions (file, session_id, project, mtime) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(file) DO UPDATE SET session_id = excluded.session_id, project = excluded.project, mtime = excluded.mtime'
  );
  up.run(sum.file, sum.id, sum.project || '', Math.floor(mtimeMs));
  return n;
}

// Rafraîchit l'index : pour chaque transcript de premier niveau, ré-indexe si mtime change.
// Supprime aussi les sessions disparues du FS. Renvoie un compte des opérations.
function refresh(projectsDir = PROJECTS_DIR) {
  const d = open();
  const sums = scanSessions(projectsDir);
  const seen = new Set();
  let indexed = 0, skipped = 0, removed = 0;
  const get = d.prepare('SELECT mtime FROM sessions WHERE file = ?');
  d.exec('BEGIN');
  try {
    for (const sum of sums) {
      seen.add(sum.file);
      let st; try { st = fs.statSync(sum.file); } catch (_) { continue; }
      const mt = Math.floor(st.mtimeMs);
      const row = get.get(sum.file);
      if (row && row.mtime === mt) { skipped++; continue; }
      indexFile(d, sum, mt);
      indexed++;
    }
    // GC : sessions plus présentes sur disque
    const all = d.prepare('SELECT file FROM sessions').all();
    const delMsg = d.prepare('DELETE FROM messages WHERE file = ?');
    const delSess = d.prepare('DELETE FROM sessions WHERE file = ?');
    for (const r of all) {
      if (seen.has(r.file)) continue;
      delMsg.run(r.file);
      delSess.run(r.file);
      removed++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { indexed, skipped, removed };
}

// Échappe une chaîne pour devenir un terme FTS5 « phrase » (entre guillemets, " doublés).
// Garantit qu'on n'envoie pas par accident une requête FTS5 (ex. : ":", "AND", "*"…).
function quotePhrase(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

// Recherche plein-texte. `q` est traité comme une suite de termes (séparés par espaces),
// chacun cité en phrase. Filtre optionnel sur project. Renvoie au plus `limit` résultats
// classés par bm25(), avec un snippet HTML <mark>...</mark> autour du match.
function search(q, opts = {}) {
  const { project = null, limit = 50, projectsDir = PROJECTS_DIR } = opts;
  const query = String(q || '').trim();
  if (!query) return [];
  refresh(projectsDir);
  const d = open();
  const tokens = query.split(/\s+/).filter(Boolean).map(quotePhrase);
  if (!tokens.length) return [];
  const ftsQuery = tokens.join(' AND ');
  const args = [ftsQuery];
  let where = 'messages_fts MATCH ?';
  if (project) { where += ' AND m.project = ?'; args.push(project); }
  args.push(Math.max(1, Math.min(500, Number(limit) || 50)));
  const sql = `
    SELECT m.session_id AS sessionId,
           m.project   AS project,
           m.role      AS role,
           m.ts        AS ts,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
           bm25(messages_fts) AS score
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    WHERE ${where}
    ORDER BY score
    LIMIT ?
  `;
  return d.prepare(sql).all(...args);
}

// Pour tests / outils : ferme la DB (libère le fichier WAL).
function close() {
  if (db) { try { db.close(); } catch (_) {} db = null; dbPath = null; }
}

export { refresh, search, close };
