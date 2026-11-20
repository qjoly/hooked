/*
 * Provider "vibe" : scan et parse des sessions Mistral Vibe (cf. docs/port-vibe.md).
 *
 * Une session Vibe vit dans ~/.vibe/logs/session/unified/<id>/ :
 *   - meta.json        : session_id, start_time/end_time, git_branch, environment.working_directory, title
 *   - journal/*.jsonl  : store CRDT append-only. Chaque ligne a un `payload` :
 *                        - `payload.delta[]` : ops append_entry/replace_entry portant une `entry`
 *                          (type message user/assistant avec content[], type effect = tool call,
 *                          type reasoning, type checkpoint…)
 *                        - `payload.kind === "completion"` : action LLM ; `payload.result.result.usage`
 *                          porte les tokens (input_tokens, output_tokens, cached_input_tokens,
 *                          cache_write_tokens) une fois l'appel terminé.
 *   - chunks/, generations/, CURRENT : ignorés ici (le journal suffit pour le résumé).
 *
 * On produit des summaries de la MÊME forme que server/transcript.js (blankSummary + provider:'vibe')
 * pour que le Deck/la sidebar/stats les consomment sans distinction. `file` pointe vers le dossier
 * <id>/journal : les consommateurs spécifiques Claude sont guardés par `provider === 'vibe'`
 * (cf. server/stats.js) et ne lisent jamais ce chemin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VIBE_SESSIONS_DIR } from './config.js';
import { blankSummary } from './transcript.js';
import { readdirSafe, statSafe, textOf, cleanPrompt, truncTitle, toolDetail, toolInputText } from './util.js';
import { costForUsage } from './pricing.js';
import { contextFromUsage } from '../src/lib/promptCache.js';

const msToIso = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

// meta.json vient de Python : "2026-11-20T09:00:00.000000+00:00" (microsecondes) n'est pas
// parsé par Date JS → on tronque en millisecondes avant.
const isoOf = (s) => {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Nom d'outil court à partir du nom qualifié Vibe ("file_system.bash" → "bash"), avec les
// renommages qui rendent live.js/provider-agnostique (AskUserQuestion…).
function vibeShortTool(name) {
  if (!name) return null;
  const last = String(name).split('.').pop();
  if (last === 'ask_user_question') return 'AskUserQuestion';
  if (last === 'exit_plan_mode') return 'ExitPlanMode';
  return last;
}

// Usage Vibe → shape Anthropic attendu par costForUsage / contextFromUsage.
function vibeUsageToAnthropic(u) {
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_write_tokens || 0,
    cache_read_input_tokens: u.cached_input_tokens || 0,
  };
}

function newVibeAcc(dir, id) {
  return {
    dir,
    s: { ...blankSummary(id, path.join(dir, 'journal')), provider: 'vibe', dir },
    entries: new Map(),  // entry.id -> entry (append_entry / replace_entry)
    usages: [],          // usage des completions terminées
    seenActions: new Set(), // action_id déjà compté (évite le double comptage input/result)
    modelCount: {},
    title: null,
    lastTsMs: 0,
  };
}

// Premier objet `usage` valide trouvé dans un sous-arbre (borné en profondeur) : l'usage d'une
// completion terminée est à payload.result.result.usage, parfois imbriqué sous payload.input…
function findUsage(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (obj.usage && typeof obj.usage === 'object' && (obj.usage.input_tokens || obj.usage.output_tokens)) return obj.usage;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const u = findUsage(v, depth + 1);
      if (u) return u;
    }
  }
  return null;
}

// Replie UNE ligne de journal Vibe dans l'accumulateur.
function foldVibeLine(acc, line) {
  if (!line) return;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  const p = j.payload;
  if (!p || typeof p !== 'object') return;
  // Usage d'un appel LLM terminé : chemin variable selon les versions (payload.result.result.usage,
  // parfois imbriqué sous payload.input…), et certaines lignes n'ont pas de `kind`. Dédup par
  // action_id : la même action apparaît souvent deux fois (requête + résultat).
  if (!p.action_id || !acc.seenActions.has(p.action_id)) {
    const u = findUsage(p.result) || findUsage(p.input);
    if (u) {
      acc.usages.push(u);
      if (p.action_id) acc.seenActions.add(p.action_id);
    }
  }
  if (!Array.isArray(p.delta)) return;
  for (const d of p.delta) {
    const e = d && d.entry;
    if (!e || !e.id) continue;
    if (d.op === 'append_entry' || d.op === 'replace_entry') acc.entries.set(e.id, e);
    if (e.createdAt > acc.lastTsMs) acc.lastTsMs = e.createdAt;
    else if (e.updatedAt > acc.lastTsMs) acc.lastTsMs = e.updatedAt;
  }
}

// Dérive le résumé (même shape que finalize de transcript.js) depuis les entrées triées par date.
function finalizeVibe(acc, meta) {
  const s = acc.s;
  if (meta && typeof meta === 'object') {
    const cwd = (meta.environment && meta.environment.working_directory) || meta.origin_directory || null;
    if (cwd) { s.project = cwd; s.projectName = path.basename(cwd); }
    if (meta.git_branch) s.gitBranch = meta.git_branch;
    const mStart = isoOf(meta.start_time);
    const mEnd = isoOf(meta.end_time);
    if (mStart && (!s.startTs || Date.parse(mStart) < Date.parse(s.startTs))) s.startTs = mStart;
    if (mEnd && (!s.lastTs || Date.parse(mEnd) > Date.parse(s.lastTs))) s.lastTs = mEnd;
    if (meta.session_id) s.sessionIdInternal = meta.session_id;
    if (meta.parent_session_id) s.forkedFrom = meta.parent_session_id; // fork ACP (session/fork)
    if (typeof meta.title === 'string' && meta.title) acc.title = meta.title;
  }
  const entries = [...acc.entries.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const e of entries) {
    const ts = msToIso(Math.max(e.createdAt || 0, e.updatedAt || 0));
    if (ts) {
      if (!s.startTs || ts < s.startTs) s.startTs = ts;
      if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
    }
    if (e.type === 'message' && e.role === 'user') {
      const t = cleanPrompt(textOf(e.content));
      if (t) {
        s.userPrompts++;
        if (!s.firstPrompt) s.firstPrompt = t;
        s.lastPrompt = t;
      }
    } else if (e.type === 'message' && e.role === 'assistant') {
      const t = cleanPrompt(textOf(e.content));
      if (t) s.lastReply = t;
      s.assistantTurns++;
      if (typeof e.model === 'string' && e.model) acc.modelCount[e.model] = (acc.modelCount[e.model] || 0) + 1;
    } else if (e.type === 'effect' && e.detail && e.detail.kind === 'tool') {
      const name = vibeShortTool(e.detail.toolName || e.title || '');
      if (name) s.tools[name] = (s.tools[name] || 0) + 1;
    }
  }
  // usage cumulé (tokens Vibe mappés sur la shape Anthropic) + coût + contexte + byDay.
  const day = (msToIso(acc.lastTsMs) || '').slice(0, 10) || 'unknown';
  s.model = Object.keys(acc.modelCount).sort((a, b) => acc.modelCount[b] - acc.modelCount[a])[0] || null;
  // le journal ne porte pas toujours le nom du modèle → pour le coût, fallback sur le tier Mistral
  const costModel = s.model || 'mistral';
  for (const u of acc.usages) {
    const ua = vibeUsageToAnthropic(u);
    const k = costForUsage(ua, costModel);
    const ctx = contextFromUsage(ua);
    if (ctx) s.lastUsage = { ts: s.lastTs || null, ...ctx };
    s.usage.input += k.inp; s.usage.output += k.out; s.usage.cacheCreate += k.cc; s.usage.cacheRead += k.cr;
    s.cost += k.total;
    s.costBreak.input += k.cIn; s.costBreak.output += k.cOut; s.costBreak.cacheCreate += k.cCc; s.costBreak.cacheRead += k.cCr;
    const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
    d.input += k.inp; d.output += k.out; d.cacheCreate += k.cc; d.cacheRead += k.cr; d.cost += k.total; d.turns++;
  }
  s.title = acc.title || truncTitle(s.firstPrompt, 80) || '(sans titre)';
  return s;
}

// Un élément de chunk "history" ({message, source, turn_index}) → pseudo-entry, dédupliquée
// contre les vraies entries via vibe_client_message_id quand il est présent.
function foldChunkElement(acc, e) {
  if (!e || typeof e !== 'object') return;
  if (e.type && e.id) { // chunk "entries" : une vraie entry (message/effect/…)
    acc.entries.set(e.id, e);
    const ts = Math.max(e.createdAt || 0, e.updatedAt || 0);
    if (ts > acc.lastTsMs) acc.lastTsMs = ts;
    return;
  }
  const m = e.message;
  if (!m || typeof m !== 'object') return; // chunk "history"
  const meta0 = Array.isArray(m.content) && m.content[0] && m.content[0]._meta;
  if (m.role === 'tool') {
    const id = 'hist-' + (m.tool_call_id || `${e.turn_index}:tool`);
    acc.entries.set(id, { id, type: 'effect', createdAt: null, detail: { kind: 'tool', toolName: m.name || '' } });
    return;
  }
  const id = (meta0 && meta0.vibe_client_message_id) || `hist:${e.turn_index}:${m.role}`;
  acc.entries.set(id, { id, type: 'message', role: m.role, content: m.content, createdAt: null, _hist: e.turn_index || 0 });
}

// Lecture mémoïsée d'un dossier de session Vibe : meta + entrées triées + usages.
// Sources : chunks/*.json (historique projeté, lu en premier) puis journal/*.jsonl (deltas
// récents, append-only — écrase les chunks par id en cas de replace). Cache key = mtime:size
// de meta.json + de chaque fichier chunk/journal (un reparse complet au changement suffit pour
// le spike — les sessions Vibe sont bien moins nombreuses que les transcripts Claude).
const vibeCache = new Map(); // dir -> { key, meta, entries, usages, summary }
function vibeRead(dir) {
  const journalDir = path.join(dir, 'journal');
  const chunkDir = path.join(dir, 'chunks');
  const jFiles = readdirSafe(journalDir).filter((f) => f.endsWith('.jsonl')).sort();
  const cFiles = readdirSafe(chunkDir).filter((f) => f.endsWith('.json')).sort();
  let key = '';
  for (const f of cFiles) {
    const st = statSafe(path.join(chunkDir, f));
    key += `c${f}:${st ? st.mtimeMs + ':' + st.size : '-'};`;
  }
  for (const f of jFiles) {
    const st = statSafe(path.join(journalDir, f));
    key += `j${f}:${st ? st.mtimeMs + ':' + st.size : '-'};`;
  }
  const metaSt = statSafe(path.join(dir, 'meta.json'));
  key += `|meta:${metaSt ? metaSt.mtimeMs + ':' + metaSt.size : '-'}`;
  const c = vibeCache.get(dir);
  if (c && c.key === key) return c;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (_) {}
  const acc = newVibeAcc(dir, path.basename(dir));
  for (const f of cFiles) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(chunkDir, f), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const e of arr) foldChunkElement(acc, e);
  }
  for (const f of jFiles) {
    let data;
    try { data = fs.readFileSync(path.join(journalDir, f), 'utf8'); } catch (_) { continue; }
    for (const line of data.split('\n')) foldVibeLine(acc, line);
  }
  let entries = [...acc.entries.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a._hist || 0) - (b._hist || 0));
  // Dédup history vs journal : une entrée "history" (createdAt null, issue des chunks projetés)
  // en doublon d'une vraie entry (même type + role + texte) est supprimée.
  const seenReal = new Set();
  for (const e of entries) {
    if (e.createdAt) seenReal.add(`${e.type}|${e.role || ''}|${textOf(e.content).slice(0, 500)}`);
  }
  entries = entries.filter((e) => e.createdAt || !seenReal.has(`${e.type}|${e.role || ''}|${textOf(e.content).slice(0, 500)}`));
  const value = { key, meta, entries, usages: acc.usages, summary: finalizeVibe(acc, meta) };
  vibeCache.set(dir, value);
  return value;
}

// Résumé d'une session Vibe (même shape que getSummary de transcript.js, + provider/dir).
function getVibeSession(dir) {
  return vibeRead(dir).summary;
}

// Scan de toutes les sessions Vibe visibles. Une session avec `parent_session_id` est un fork
// (session/fork ACP) tant que le parent ne la déclare pas dans `child_sessions` — un vrai
// sous-agent (spawn via agent_path /root/<name>) y est déclaré et reste exclu, comme
// agent-*.jsonl côté Claude. Les forks sont inclus et marqués `forkedFrom`.
function scanVibeSessions(sessionsDir = VIBE_SESSIONS_DIR) {
  const dirs = readdirSafe(sessionsDir)
    .map((d) => path.join(sessionsDir, d))
    .filter((dir) => {
      const st = statSafe(dir);
      return st && st.isDirectory() && statSafe(path.join(dir, 'journal')); // session unified
    });
  const metas = new Map(); // session_id -> meta
  for (const dir of dirs) {
    const meta = vibeRead(dir).meta;
    if (meta && meta.session_id) metas.set(meta.session_id, meta);
  }
  const out = [];
  for (const dir of dirs) {
    const { meta, summary } = vibeRead(dir);
    const parentId = meta && meta.parent_session_id;
    if (parentId) {
      const parent = metas.get(parentId);
      const isSubagent = parent && Array.isArray(parent.child_sessions) && parent.child_sessions.includes(meta.session_id);
      if (isSubagent) continue; // sous-agent : coût replié plus tard si besoin
      // sinon : fork → visible, marqué forkedFrom dans finalizeVibe
    }
    out.push(summary);
  }
  return out;
}

// Sortie d'un tool Vibe. Sur un tool terminé, `state.output` vaut
// { content:[{type:'text',text}…], structured_content:{command,returncode,stdout,stderr…}, type }
// et `state.outputText` existe mais reste VIDE — d'où l'ancien affichage « pas de détail ».
function vibeToolOutput(state) {
  if (!state || typeof state !== 'object') return null;
  if (typeof state.outputText === 'string' && state.outputText) return state.outputText;
  const out = state.output;
  if (!out) return null;
  if (typeof out === 'string') return out;
  if (Array.isArray(out.content)) {
    const texts = out.content
      .filter((b) => b && typeof b.text === 'string' && b.text)
      .map((b) => b.text);
    if (texts.length) return texts.join('\n');
  }
  const sc = out.structured_content;
  if (sc && typeof sc === 'object') {
    const parts = [];
    if (typeof sc.stdout === 'string' && sc.stdout) parts.push(sc.stdout.replace(/\n+$/, ''));
    if (typeof sc.stderr === 'string' && sc.stderr) parts.push(sc.stderr.replace(/\n+$/, ''));
    if (parts.length) {
      const rc = sc.returncode;
      const head = (typeof rc === 'number' && rc !== 0) ? `[exit code ${rc}]\n` : '';
      return head + parts.join('\n');
    }
    // structured_content d'un autre tool (read_file, etc.) → JSON lisible
    const keys = Object.keys(sc);
    if (keys.length) return JSON.stringify(sc, null, 2);
  }
  return null;
}

// Conversation style chat (même shape que buildConversation de conversation.js) :
// 1 bulle user / 1 bulle assistant, les tool calls (effects) rattachés à la bulle assistant
// en cours. Le texte est tronqué comme côté Claude (TEXT_CAP) via le front ; ici on renvoie le texte brut.
function buildVibeConversation(dir) {
  const { entries } = vibeRead(dir);
  const msgs = [];
  // Dans le journal Vibe, les tool calls (effects) d'un tour PRÉCÉDENT le message assistant
  // final : on les accumule et on les rattache à la prochaine bulle assistant.
  let pendingTools = [];
  for (const e of entries) {
    const ts = msToIso(Math.max(e.createdAt || 0, e.updatedAt || 0));
    if (e.type === 'message' && e.role === 'user') {
      const text = cleanPrompt(textOf(e.content));
      if (text) { msgs.push({ role: 'user', ts, text, tools: [] }); pendingTools = []; }
    } else if (e.type === 'message' && e.role === 'assistant') {
      // PAS de cleanPrompt ici : il aplatirait les \n (\s+ → ' ') et casserait le markdown.
      // On retire juste les balises <...> en conservant les retours à la ligne.
      const text = textOf(e.content).replace(/<[^>]+>/g, '');
      // bulle assistant vide et sans outil (projection history) → on la saute
      if (text || pendingTools.length) {
        msgs.push({ role: 'assistant', ts, text, tools: pendingTools });
        pendingTools = [];
      }
    } else if (e.type === 'effect' && e.detail && e.detail.kind === 'tool') {
      // Shape alignée sur les tools Claude (server/conversation.js) : ToolChip (web) et
      // desktop-rune lisent `detail` / `inputText` / `result` — sans eux le chip n'est
      // même pas dépliable ("pas de détail" sur les appels bash).
      const input = e.detail.input || null;
      const output = vibeToolOutput(e.state);
      pendingTools.push({
        id: e.toolCallId || e.id || null,
        name: vibeShortTool(e.detail.toolName || e.title || ''),
        detail: toolDetail(input) || undefined,
        inputText: toolInputText(input) || undefined,
        result: output,
        status: (e.state && e.state.status) || null,
        input,
        output,
      });
    }
  }
  return msgs;
}

export { scanVibeSessions, getVibeSession, buildVibeConversation, vibeToolOutput, vibeShortTool, vibeUsageToAnthropic };
