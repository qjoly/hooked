/*
 * Usage sur une fenêtre glissante (la « session de 5 h » de l'abonnement Claude, dont la
 * limite est globale au compte). On a besoin d'une granularité plus fine que byDay, donc on
 * construit une *timeline* par tour assistant {ts(ms), cost, out, total}, mise en cache par
 * mtime/size du fichier. Distinct de parseTranscript (qu'on ne touche pas : tests différentiels).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, SESSION_BUDGET, SESSION_HOURS } from './config.js';
import { readdirSafe, statSafe } from './util.js';
import { costForUsage } from './pricing.js';

const timelineCache = new Map(); // path -> { key, turns: [{ts, cost, out, total}] }

// extrait la timeline d'un transcript (tours assistant + usage des sous-agents).
function fileTimeline(fp) {
  const st = statSafe(fp);
  if (!st) return [];
  const key = st.mtimeMs + ':' + st.size;
  const cached = timelineCache.get(fp);
  if (cached && cached.key === key) return cached.turns;
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const turns = [];
  const seen = new Set();
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const ts = j.timestamp ? Date.parse(j.timestamp) : NaN;
    if (j.type === 'assistant' && j.message && j.message.usage) {
      const msg = j.message;
      const mid = msg.id || (j.timestamp + ':' + msg.usage.output_tokens);
      if (seen.has(mid)) continue;
      seen.add(mid);
      const k = costForUsage(msg.usage, msg.model);
      if (!isNaN(ts)) turns.push({ ts, cost: k.total, out: k.out, total: k.inp + k.out + k.cc + k.cr });
    } else if (j.toolUseResult && j.toolUseResult.usage && (j.toolUseResult.agentType || j.toolUseResult.agentId)) {
      const k = costForUsage(j.toolUseResult.usage, j.toolUseResult.resolvedModel);
      if (!isNaN(ts)) turns.push({ ts, cost: k.total, out: k.out, total: k.inp + k.out + k.cc + k.cr });
    }
  }
  timelineCache.set(fp, { key, turns });
  return turns;
}

// usage cumulé sur les `hours` dernières heures, tous transcripts confondus, + progression
// vis-à-vis du budget de session (barre « limite de session »).
function usageWindow(hours = SESSION_HOURS, projectsDir = PROJECTS_DIR, now = Date.now(), budget = SESSION_BUDGET) {
  const since = now - hours * 3600000;
  let firstMs = null;
  const out = { hours, since: new Date(since).toISOString(), cost: 0, output: 0, tokens: 0, turns: 0, firstTs: null, budget, pct: 0, resetAt: null, resetInMin: null };
  for (const proj of readdirSafe(projectsDir)) {
    const pdir = path.join(projectsDir, proj);
    const st = statSafe(pdir);
    if (!st || !st.isDirectory()) continue;
    for (const f of readdirSafe(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const t of fileTimeline(path.join(pdir, f))) {
        if (t.ts < since) continue;
        out.cost += t.cost; out.output += t.out; out.tokens += t.total; out.turns++;
        if (firstMs == null || t.ts < firstMs) firstMs = t.ts;
      }
    }
  }
  // % du budget (borné à 100). Le bloc de 5 h est ancré sur la 1re activité de la fenêtre :
  // il « se réinitialise » `hours` après celle-ci (approximation de la session Claude).
  out.pct = budget > 0 ? Math.min(100, Math.round((out.cost / budget) * 100)) : 0;
  if (firstMs != null) {
    out.firstTs = new Date(firstMs).toISOString();
    const resetMs = firstMs + hours * 3600000;
    out.resetAt = new Date(resetMs).toISOString();
    out.resetInMin = Math.max(0, Math.round((resetMs - now) / 60000));
  }
  return out;
}

export { usageWindow, fileTimeline };
