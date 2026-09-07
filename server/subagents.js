/*
 * Reconstruit la liste des sous-agents lancés via l'outil Agent/Task : on apparie chaque
 * tool_use (consigne) avec son tool_result (résultat final) par tool_use_id.
 * Les tours internes du sous-agent ne sont PAS dans ce transcript (seuls entrée+sortie le sont).
 */
import fs from 'node:fs';
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
  return calls;
}

export { buildSubagents };
