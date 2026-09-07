/*
 * Reconstruit la liste des modifications de fichiers (Edit / Write / MultiEdit / NotebookEdit)
 * faites par Claude au fil de la session, regroupées par fichier (dernier touché d'abord).
 *
 * Pour chaque fichier, on tente de rejouer les edits À REBOURS sur le contenu actuel du fichier
 * sur disque afin de retrouver son état pré-session : deux edits qui se chevauchent (la même zone
 * retouchée deux fois) fusionnent alors en UN seul diff réel, au lieu d'empiler des états
 * intermédiaires trompeurs. Si la reconstruction n'est pas fiable (fichier disparu/modifié depuis,
 * Write sans état antérieur connu ailleurs qu'en tête d'historique, notebook, trop gros), on
 * retombe sur les ops brutes.
 *
 * Un Write ne porte QUE le nouveau contenu : l'état qu'il écrase est lu sur la ligne de résultat
 * (`toolUseResult.originalFile`) et attaché à l'op (`old`). Sans lui, une réécriture intégrale
 * s'affichait comme une création de fichier (tout en ajout) au lieu d'un vrai diff.
 *
 * Les contenus sont bornés par défaut (payload du détail de session). Un fichier dont un op dépasse
 * ces bornes (ou trop gros pour la reconstruction) est marqué `truncated:true` ; la lentille Ship
 * propose alors de charger le diff COMPLET à la demande via buildFileChangeFull (caps = Infinity).
 *
 * S'y ajoutent les modifications faites PAR LES COMMANDES BASH (invisibles dans le transcript) :
 * hook.cjs les capture (diff d'état git avant/après chaque Bash) dans
 * <HOOKED_DIR>/bash-changes/<session_id>.jsonl sous forme de SHAs de blobs git, résolus ici via
 * un `git cat-file --batch` par dépôt puis fusionnés comme des ops `edit` plein-fichier (old/new =
 * contenu complet), horodatées → le filtre par prompt du Ship marche tel quel. Un blob élagué par
 * `git gc` (sessions > ~2 semaines) fait ignorer l'op silencieusement.
 *
 * Perf : ce module est sur le chemin chaud de sessionDetail (rejoué à chaque tick de poll). Trois
 * caches l'y rendent quasi gratuit — le scan d'un transcript (mtime+taille), les contenus de blobs
 * (immuables, LRU par octets) et le résultat complet (buildFileChanges, invalidé par les sources ET
 * l'état disque des fichiers touchés). Tout est synchrone : sans eux, une session bavarde en
 * commandes Bash bloquait l'event loop plusieurs secondes par requête.
 *
 * Et les modifications faites PAR LES SOUS-AGENTS (outil Agent/Task) : leurs Edit/Write vivent
 * dans des transcripts séparés (<pdir>/<sessionId>/subagents/agent-*.jsonl — les agents imbriqués
 * y sont à plat aussi), scannés et fusionnés ici avec un tag `agent:<id>` par op. Le tri
 * chronologique (ts ISO) interleave les trois sources ; le filtre par prompt marche tel quel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOOKED_DIR } from './config.js';
import { agentTranscriptPath } from './transcript.js';
import { buildSubagents } from './subagents.js';

// Default caps keep the session-detail payload lean. A file that overflows them is flagged
// `truncated` and the Ship lens offers to load the FULL diff on demand (buildFileChangeFull).
// Note: a file whose edits reconstruct cleanly shows its full net content regardless (the net
// `new` is the on-disk file, ≤ MERGE_MAX) — the caps only bound the raw-op fallback / per-prompt.
const EDIT_MAX = 12000;
const WRITE_MAX = 24000;
const MERGE_MAX = 60000; // au-delà : pas de reconstruction, ops brutes
const RAW_KEEP = 40;     // on ne garde que les N dernières ops brutes

function reconstructOriginal(file, ops, mergeMax) {
  let final;
  try { final = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  if (final.length > mergeMax) return null;
  let text = final;
  let applied = 0;
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.kind === 'notebook') return null;
    if (o.kind === 'write') {
      // Full rewrite: its inverse is simply "put the previous content back". That content is only
      // known when the result line carried it (o.old, cf. writeOriginals) — otherwise all we can
      // safely assume is that the file didn't exist, and only at the very start of the history.
      if (o.old != null) { text = o.old; applied++; continue; }
      if (i !== 0) return null;
      text = '';
      applied++;
      continue;
    }
    // Skip an edit whose new_string is no longer present: a later overlapping edit already
    // reverted this region (near-duplicate edits at the same spot). Bailing instead would fall
    // back to raw per-edit cards and show the intermediate state twice.
    if (o.all) {
      if (o.new && text.includes(o.new)) { text = text.split(o.new).join(o.old); applied++; }
    } else {
      const idx = o.new ? text.indexOf(o.new) : -1;
      if (idx >= 0) { text = text.slice(0, idx) + o.old + text.slice(idx + o.new.length); applied++; }
    }
  }
  if (!applied || text === final || text.length > mergeMax) return null;
  return { old: text, new: final };
}

function truncateOp(o, editMax, writeMax) {
  if (o.kind === 'write') return { kind: 'write', content: o.content.slice(0, writeMax), ...(o.old != null ? { old: o.old.slice(0, writeMax) } : {}), ts: o.ts, ...(o.agent ? { agent: o.agent } : {}) };
  if (o.kind === 'notebook') return { kind: 'notebook', new: o.new.slice(0, editMax), ts: o.ts, ...(o.agent ? { agent: o.agent } : {}) };
  return { kind: 'edit', old: o.old.slice(0, editMax), new: o.new.slice(0, editMax), all: o.all, ts: o.ts, ...(o.bash ? { bash: true } : {}), ...(o.agent ? { agent: o.agent } : {}) };
}

// A raw op is "too big" for the given caps → its content would be sliced (→ missing lines).
function opTooBig(o, editMax, writeMax) {
  if (o.kind === 'write') return (o.content || '').length > writeMax || (o.old || '').length > writeMax;
  if (o.kind === 'notebook') return (o.new || '').length > editMax;
  return (o.old || '').length > editMax || (o.new || '').length > editMax;
}
function diskTooBig(file, mergeMax) {
  try { return fs.statSync(file).size > mergeMax; } catch (_) { return false; }
}

// Pre-write file contents, by tool_use_id. A Write's `tool_use` carries only the NEW content: the
// state it overwrote lives on the RESULT line (`toolUseResult.originalFile`, non-empty only when
// the file already existed). Without it, a full rewrite reconstructs as "file created" and the
// whole file reads as added instead of showing the real diff.
function writeOriginals(lines) {
  const out = new Map();
  for (const line of lines) {
    if (!line || !line.includes('originalFile')) continue; // pré-filtre : évite N parses inutiles
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const r = j && j.toolUseResult;
    if (!r || typeof r !== 'object' || typeof r.originalFile !== 'string' || !r.originalFile) continue;
    const content = j.message && j.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_result' && b.tool_use_id) out.set(b.tool_use_id, r.originalFile);
    }
  }
  return out;
}

// Scan a transcript into per-file ops (full, untruncated). One place both the capped list and the
// on-demand full builder go through.
function scanOps(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return new Map(); }
  const lines = data.split('\n');
  const originals = writeOriginals(lines);
  const byFile = new Map(); // path -> { file, name, tool, ops: [...], count, lastTs }
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
    const ts = j.timestamp || null;
    for (const b of j.message.content) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      const inp = b.input;
      const file = inp.file_path || inp.path || inp.notebook_path;
      if (!file) continue;
      const ops = [];
      if (b.name === 'Write') {
        const prev = b.id ? originals.get(b.id) : null;
        ops.push({ kind: 'write', content: String(inp.content || ''), ...(prev ? { old: prev } : {}) });
      } else if (b.name === 'Edit') {
        ops.push({ kind: 'edit', old: String(inp.old_string || ''), new: String(inp.new_string || ''), all: !!inp.replace_all });
      } else if (b.name === 'MultiEdit' && Array.isArray(inp.edits)) {
        for (const e of inp.edits) ops.push({ kind: 'edit', old: String(e.old_string || ''), new: String(e.new_string || ''), all: !!e.replace_all });
      } else if (b.name === 'NotebookEdit') {
        ops.push({ kind: 'notebook', new: String(inp.new_source || '') });
      } else {
        continue;
      }
      const entry = byFile.get(file) || { file, name: path.basename(file), tool: b.name, ops: [], count: 0, lastTs: ts };
      for (const o of ops) entry.ops.push({ ...o, ts });
      entry.count += ops.length;
      entry.lastTs = ts || entry.lastTs;
      byFile.set(file, entry);
    }
  }
  return byFile;
}

// Scan caché par mtime+size : sessionDetail tourne à chaque poll et fusionne désormais N
// transcripts (principal + sous-agents) — un transcript d'agent terminé ne bouge plus, son scan
// est donc quasi permanent en cache. Les maps cachées ne sont JAMAIS mutées (collect() copie).
const scanCache = new Map(); // fp -> { key, byFile }
function scanOpsCached(fp) {
  let st;
  try { st = fs.statSync(fp); } catch (_) { return new Map(); }
  const key = st.mtimeMs + ':' + st.size;
  const hit = scanCache.get(fp);
  if (hit && hit.key === key) return hit.byFile;
  const byFile = scanOps(fp);
  if (scanCache.size >= 300) scanCache.clear();
  scanCache.set(fp, { key, byFile });
  return byFile;
}

// ── Subagent transcripts ─────────────────────────────────────────────────────────────────────────

// Transcripts des sous-agents de la session : layout niché <pdir>/<sessionId>/subagents/
// agent-*.jsonl (les agents imbriqués y sont stockés à plat aussi → tout est attrapé d'un coup).
// Fallback legacy (layouts anciens, agents à plat dans le dossier projet) : agentId extraits du
// transcript principal (toolUseResult.agentId) + agentTranscriptPath, qui vérifie l'appartenance.
function agentTranscripts(fp, sessionId) {
  const dir = path.join(path.dirname(fp), path.basename(fp).replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  const out = names
    .filter((n) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n))
    .map((n) => ({ agentId: n.slice(6, -6), fp: path.join(dir, n) }));
  if (out.length || !sessionId) return out;
  for (const a of buildSubagents(fp)) {
    if (!a.agentId) continue;
    const p = agentTranscriptPath(sessionId, a.agentId);
    if (p) out.push({ agentId: a.agentId, fp: p });
  }
  return out;
}

// Toutes les ops de la session, trois sources fusionnées : transcript principal, transcripts de
// sous-agents (ops taguées `agent:<id>`), commandes Bash (hook). Copie systématique des entries
// (les maps issues du cache sont partagées) ; tri chronologique dès qu'un fichier mélange les
// sources — les ops mono-source gardent l'ordre du transcript (dont celles sans ts).
function collect(fp, sessionId) {
  const byFile = new Map();
  const mergeFrom = (src, agentId) => {
    for (const [file, e] of src) {
      const entry = byFile.get(file) || { file, name: e.name, tool: e.tool, ops: [], count: 0, lastTs: null };
      for (const o of e.ops) entry.ops.push(agentId ? { ...o, agent: agentId } : o);
      entry.count += e.count;
      if (e.lastTs && (!entry.lastTs || e.lastTs > entry.lastTs)) entry.lastTs = e.lastTs;
      byFile.set(file, entry);
    }
  };
  mergeFrom(scanOpsCached(fp), null);
  for (const a of agentTranscripts(fp, sessionId)) mergeFrom(scanOpsCached(a.fp), a.agentId);
  mergeBashOps(byFile, sessionId);
  for (const e of byFile.values()) {
    if (e.ops.some((o) => o.agent || o.bash)) e.ops.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  }
  return byFile;
}

// ── Bash-command changes (captured by hook.cjs) ──────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{40,64}$/;
const BLOB_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const blobCache = new Map(); // `${root}:${sha}` -> content|null — LRU par budget d'octets
let blobCacheBytes = 0;

// Un blob git est immuable : une fois lu, il n'a jamais à être relu. On évince donc les plus
// anciennes entrées jusqu'à repasser sous le budget (l'ancien `clear()` global vidait le cache
// d'un coup et faisait re-spawner git pour TOUTE la session au tick suivant).
function blobCacheSet(key, content) {
  if (blobCache.has(key)) blobCacheBytes -= blobCache.get(key)?.length || 0;
  blobCache.set(key, content);
  blobCacheBytes += content?.length || 0;
  while (blobCacheBytes > BLOB_CACHE_MAX_BYTES && blobCache.size > 1) {
    const [k, v] = blobCache.entries().next().value;
    blobCache.delete(k);
    blobCacheBytes -= v?.length || 0;
  }
}

// Contenus de N blobs d'un même dépôt, en UN SEUL `git cat-file --batch` (stdin = les SHAs,
// stdout = `<oid> <type> <size>\n<contenu>\n` par blob, ou `<oid> missing\n`). L'ancienne version
// spawnait un `git cat-file blob` par SHA : ~800 spawns synchrones (≈ 2,8 s d'event loop bloqué)
// pour une session bavarde en commandes Bash, à CHAQUE appel. → Map sha -> contenu | null
// (null = irrécupérable : blob gc'é, repo disparu, sortie illisible).
function catBlobs(root, shas) {
  const out = new Map();
  const want = [];
  for (const sha of shas) {
    if (out.has(sha)) continue;
    if (!SHA_RE.test(sha || '')) { out.set(sha, null); continue; }
    const key = root + ':' + sha;
    if (blobCache.has(key)) out.set(sha, blobCache.get(key));
    else { out.set(sha, null); want.push(sha); }
  }
  if (!want.length) return out;
  let buf;
  try {
    buf = execFileSync('git', ['-C', root, 'cat-file', '--batch'],
      { input: want.join('\n') + '\n', timeout: 20000, maxBuffer: 256 * 1024 * 1024 });
  } catch (_) {
    for (const sha of want) blobCacheSet(root + ':' + sha, null); // repo mort : ne pas re-spawner
    return out;
  }
  // La sortie suit l'ordre des SHAs demandés. Un en-tête illisible = désynchronisation : on
  // abandonne le reste du lot (les SHAs non résolus restent à null) plutôt que de découper à côté.
  let i = 0;
  for (const sha of want) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = buf.toString('utf8', i, nl).split(' ');
    i = nl + 1;
    if (header.length < 3 || header[1] !== 'blob') {
      blobCacheSet(root + ':' + sha, null);          // `missing` (blob élagué par git gc)
      if (header.length >= 2 && header[1] === 'missing') continue;
      break;
    }
    const size = parseInt(header[2], 10);
    if (!Number.isFinite(size) || i + size > buf.length) break;
    const content = buf.toString('utf8', i, i + size);
    i += size + 1;                                    // + le LF de fin ajouté par git
    out.set(sha, content);
    blobCacheSet(root + ':' + sha, content);
  }
  return out;
}

// Journal des modifications Bash de la session (déposé par hook.cjs).
function bashChangesPath(sessionId) {
  return path.join(HOOKED_DIR, 'bash-changes', sessionId + '.jsonl');
}

// mtime+taille d'un fichier, ou '-' s'il est absent. Brique des signatures de cache.
function sigOf(file) {
  try { const st = fs.statSync(file); return st.mtimeMs + ':' + st.size; } catch (_) { return '-'; }
}

// Ops plein-fichier issues des commandes Bash de la session, fusionnées dans byFile (même forme
// que scanOps). Une op dont un blob non-null ne se résout plus est ignorée (pas de faux diff).
function mergeBashOps(byFile, sessionId) {
  if (!sessionId || !/^[\w.-]+$/.test(String(sessionId))) return;
  const fp = bashChangesPath(sessionId);
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return; }
  const entries = [];
  const shasByRoot = new Map(); // root -> Set(sha) — un seul `cat-file --batch` par dépôt
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (!j || !j.file || !j.root) continue;
    entries.push(j);
    const want = shasByRoot.get(j.root) || new Set();
    if (j.old !== null) want.add(j.old);
    if (j.new !== null) want.add(j.new);
    shasByRoot.set(j.root, want);
  }
  const blobs = new Map(); // root -> Map(sha -> content|null)
  for (const [root, shas] of shasByRoot) blobs.set(root, catBlobs(root, [...shas]));
  for (const j of entries) {
    const resolved = blobs.get(j.root);
    const oldText = j.old === null ? '' : resolved.get(j.old) ?? null;
    const newText = j.new === null ? '' : resolved.get(j.new) ?? null;
    if (oldText === null || newText === null || oldText === newText) continue;
    const entry = byFile.get(j.file) || { file: j.file, name: path.basename(j.file), tool: 'Bash', ops: [], count: 0, lastTs: j.ts || null };
    entry.ops.push({ kind: 'edit', old: oldText, new: newText, all: false, ts: j.ts || null, bash: true });
    entry.count += 1;
    if (j.ts && (!entry.lastTs || j.ts > entry.lastTs)) entry.lastTs = j.ts;
    byFile.set(j.file, entry);
  }
  // NB : l'interleaving chronologique avec les autres sources est fait par collect().
}

// Build one output entry from an accumulated file entry, under the given caps.
function buildEntry(e, editMax, writeMax, mergeMax) {
  const merged = reconstructOriginal(e.file, e.ops, mergeMax);
  const ops = merged
    ? [{ kind: 'edit', old: merged.old, new: merged.new, all: false, ts: e.lastTs }]
    : e.ops.slice(-RAW_KEEP).map((o) => truncateOp(o, editMax, writeMax));
  // `original` (état pré-session reconstruit) + `rawOps` (ordonnées, horodatées) permettent au
  // client (lentille Ship) de rejouer l'historique et d'afficher le diff d'un ou plusieurs prompts.
  const rawOps = e.ops.slice(-RAW_KEEP).map((o) => ({ ...truncateOp(o, editMax, writeMax), ts: o.ts }));
  // Marqué tronqué quand un contenu a été rogné : op au-dessus des bornes, ou fichier trop gros pour
  // la reconstruction (→ fallback rogné). Faux quand les bornes sont infinies (build complet).
  const truncated = Number.isFinite(editMax)
    && (e.ops.some((o) => opTooBig(o, editMax, writeMax)) || (!merged && diskTooBig(e.file, mergeMax)));
  return { file: e.file, name: e.name, tool: e.tool, ops, count: e.count, lastTs: e.lastTs, original: merged ? merged.old : null, rawOps, truncated };
}

// Mémo du résultat complet : sessionDetail tourne à chaque tick de poll et reconstruisait à chaque
// fois les mêmes mégaoctets de diffs. La signature couvre TOUTES les entrées du calcul :
//   - les sources d'ops (transcript principal, journal bash, transcripts de sous-agents) ;
//   - l'état sur disque des fichiers touchés — reconstructOriginal les relit, donc une édition
//     hors-session (ou un `git checkout`) doit invalider l'entrée.
// Le tableau rendu est PARTAGÉ : les appelants le sérialisent (payload d'API), ils ne le mutent pas.
const CHANGES_MEMO_MAX = 8;
const changesMemo = new Map(); // `${fp}|${sessionId}` -> { sig, files, diskSig, out }

function inputSig(fp, sessionId) {
  const parts = [sigOf(fp)];
  if (sessionId) {
    parts.push(sigOf(bashChangesPath(sessionId)));
    for (const a of agentTranscripts(fp, sessionId)) parts.push(a.agentId + '=' + sigOf(a.fp));
  }
  return parts.join('|');
}
const diskSig = (files) => files.map(sigOf).join('|');

// `sessionId` (optionnel) : fusionne aussi les modifs des sous-agents et celles capturées sur les
// commandes Bash de la session (hook.cjs) — absent pour le drill-in d'UN transcript de sous-agent
// (/api/agent), qui ne montre que les ops de cet agent.
function buildFileChanges(fp, sessionId) {
  const key = fp + '|' + (sessionId || '');
  const sig = inputSig(fp, sessionId);
  const hit = changesMemo.get(key);
  if (hit && hit.sig === sig && hit.diskSig === diskSig(hit.files)) return hit.out;
  const byFile = sessionId ? collect(fp, sessionId) : scanOps(fp);
  const out = [...byFile.values()].map((e) => buildEntry(e, EDIT_MAX, WRITE_MAX, MERGE_MAX));
  out.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  const files = [...byFile.keys()];
  if (changesMemo.size >= CHANGES_MEMO_MAX && !changesMemo.has(key)) {
    changesMemo.delete(changesMemo.keys().next().value); // la plus ancienne session consultée
  }
  changesMemo.set(key, { sig, files, diskSig: diskSig(files), out });
  return out;
}

// Full (uncapped) change entry for ONE file, loaded on demand by the Ship lens when a file was
// flagged `truncated`. Infinity caps → no slicing, no size bail on reconstruction. null if the file
// wasn't touched in this transcript.
function buildFileChangeFull(fp, filePath, sessionId) {
  const byFile = sessionId ? collect(fp, sessionId) : scanOps(fp);
  const e = byFile.get(filePath);
  if (!e) return null;
  return buildEntry(e, Infinity, Infinity, Infinity);
}

export { buildFileChanges, buildFileChangeFull };
