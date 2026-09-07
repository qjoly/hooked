import { agentAlive, setAutoApprove } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Active / coupe l'auto-approbation des demandes de permission d'outil pour une session.
//
// À quoi ça sert : `canUseTool` n'est consulté que pour les appels que Claude Code a décidé
// d'escalader (une règle `ask` de l'utilisateur, ou le classifieur du mode `auto` qui juge l'appel
// risqué). Sans ça, chacun de ces appels bloque la session sur une carte à valider à la main.
//
// Pourquoi pas simplement `permissionMode: 'bypassPermissions'` : ce mode court-circuite
// `canUseTool` EN AMONT (le SDK avertit `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`), donc les
// AskUserQuestion et les ExitPlanMode ne remonteraient plus à l'UI — ils seraient auto-validés sans
// que tu voies rien. Ici on ne laisse passer que les outils, les hand-off continuent d'arriver.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const { id } = body;
  if (!id) return fail(400, 'id required');
  if (typeof body.on !== 'boolean') return fail(400, '`on` boolean required');
  if (!agentAlive(id)) return fail(409, 'this session is not driven by hooked (ended, or started outside hooked)');
  const { err, info } = await toPromise((cb) => setAutoApprove(id, body.on, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
