/*
 * Reconstruit la liste des sous-agents lancés via l'outil Agent/Task : on apparie chaque
 * tool_use (consigne) avec son tool_result (résultat final) par tool_use_id.
 * Les tours internes du sous-agent ne sont PAS dans ce transcript (seuls entrée+sortie le sont).
 */
import fs from 'node:fs';
import path from 'node:path';
import { costForUsage } from './pricing.js';

function buildSubagents(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const calls = []; // ordre d'apparition
  const byId = new Map();
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && b.id) {
          if (byId.has(b.id)) continue; // même tool_use dupliqué dans le transcript (resume/compaction) → une seule carte
          const inp = b.input || {};
          const call = {
            id: b.id,
            type: inp.subagent_type || null,
            description: inp.description || '',
            prompt: String(inp.prompt || '').slice(0, 12000),
            result: null,
            ts: j.timestamp || null,
            model: null, totalTokens: null, toolUses: null, durationMs: null, cost: null,
            agentId: null, // rempli depuis toolUseResult.agentId → permet le drill-in /api/agent
          };
          calls.push(call);
          byId.set(b.id, call);
        }
      }
    } else if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      const tur = j.toolUseResult; // métadonnées du sous-agent : usage, resolvedModel, totalTokens…
      for (const b of j.message.content) {
        if (b.type === 'tool_result' && byId.has(b.tool_use_id)) {
          const call = byId.get(b.tool_use_id);
          const c = b.content;
          const txt = Array.isArray(c)
            ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n')
            : (typeof c === 'string' ? c : '');
          call.result = txt.slice(0, 12000);
          if (tur && tur.usage) {
            call.model = tur.resolvedModel || null;
            call.totalTokens = tur.totalTokens || 0;
            call.toolUses = tur.totalToolUseCount || 0;
            call.durationMs = tur.totalDurationMs || 0;
            call.cost = costForUsage(tur.usage, tur.resolvedModel).total;
          }
          if (tur && tur.agentId) call.agentId = tur.agentId;
        }
      }
    }
  }
  const known = new Set(calls.map((c) => c.agentId).filter(Boolean));
  calls.push(...discoverRunningSubagents(fp, known));
  return calls;
}

/*
 * Agents que le transcript principal ne DÉCLARE pas encore. Un skill lancé en commande slash
 * (/code-review) délègue à un sous-agent foreground, et le CLI n'écrit le tour parent — donc le
 * `tool_use` que buildSubagents apparie — qu'une fois ce sous-agent terminé. Pendant tout son
 * travail, la seule trace est son propre fichier, qui lui grossit en direct : sans cette passe,
 * l'onglet des sous-agents reste vide exactement quand on voudrait regarder dedans.
 *
 * Les agents d'un run de Workflow sont laissés de côté : la carte Workflows les rend déjà, avec
 * leurs phases (cf. server/workflows.js).
 */
function discoverRunningSubagents(fp, known) {
  const dir = path.join(path.dirname(fp), path.basename(fp, '.jsonl'), 'subagents');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
    const agentId = e.name.slice('agent-'.length, -'.jsonl'.length);
    if (known.has(agentId)) continue;
    const file = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    const meta = readAgentMeta(path.join(dir, `agent-${agentId}.meta.json`));
    const head = readAgentHead(file);
    out.push({
      id: 'running-' + agentId,
      agentId,
      type: meta.agentType || null,
      description: head.description || '',
      prompt: head.prompt || '',
      result: null,          // en cours : le résultat n'existe pas encore
      ts: head.ts || new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
      model: null, totalTokens: null, toolUses: null, durationMs: null, cost: null,
      running: true,
    });
  }
  return out;
}

function readAgentMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; }
}

// Première consigne du sous-agent : son premier tour `user`, le seul endroit où sa mission est
// écrite tant que le parent n'a pas journalisé le `tool_use` correspondant.
function readAgentHead(file) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch (_) { return {}; }
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'user' || !j.message) continue;
    const c = j.message.content;
    const text = typeof c === 'string'
      ? c
      : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '');
    const t = text.trim();
    if (!t) continue;
    return { prompt: t.slice(0, 12000), description: t.split('\n')[0].slice(0, 200), ts: j.timestamp || null };
  }
  return {};
}

export { buildSubagents, discoverRunningSubagents };
