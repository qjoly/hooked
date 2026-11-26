import { json } from '@sveltejs/kit';
import {
  listMcp, getMcp, logoutMcp, startLogin, loginStatus, sendLoginInput, cancelLogin, listMcpPi,
  getMcpPi, saveMcpPi, removeMcpPi, engineOf, migrateLegacyToml,
} from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// MCP servers of a project: health-checked list + scope + config diagnostics.
// `cwd` matters — project and local scopes are per-directory (see server/mcp.js).
// `provider=pi` : liste lue dans les mcp.json de Pi (~/.pi/agent/mcp.json + <cwd>/.pi/mcp.json),
// health-check HTTP uniquement (les stdio restent « configured ») — cf. server/piMcp.js.
// `provider` is any provider id: its engine says which MCP flavour applies ('claude' | 'pi' | none).
function mcpKind(provider) {
  if (!provider || provider === 'claude') return 'claude';
  if (provider === 'pi') return 'pi';
  const e = engineOf(provider);
  return e ? e.mcpKind || null : 'claude';
}

export async function GET({ url }) {
  const provider = url.searchParams.get('provider');
  const cwd = url.searchParams.get('cwd');
  const kind = mcpKind(provider);
  if (!kind) return json({ servers: [], diagnostics: [], unsupported: true });
  if (kind === 'pi') {
    return json(await listMcpPi(cwd, { check: url.searchParams.get('check') === '1' }));
  }
  // `profile`: the account of a connection profile (its own servers and connectors), plus the servers
  // hooked adds for it, instead of the default account's.
  try {
    return json(await listMcp(cwd, { cached: url.searchParams.get('cached') === '1', profile: url.searchParams.get('profile') || null }));
  } catch (e) {
    return fail(400, e && e.message ? e.message : 'mcp lookup failed');
  }
}

// Everything that mutates or blocks: OAuth login (start / poll / paste back / cancel), logout,
// and the per-server detail read, which costs its own health-checked spawn.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.action !== 'string') return fail(400, 'action required');
  const { action, cwd, name, id, text, provider, scope, config } = body;
  const isPi = mcpKind(provider) === 'pi';
  const profile = typeof body.profile === 'string' && body.profile ? body.profile : null;
  try {
    switch (action) {
      case 'get':
        if (!name) return fail(400, 'name required');
        if (isPi) return json({ ok: true, ...getMcpPi(cwd, name) });
        return json({ ok: true, ...(await getMcp(cwd, name, profile)) });
      case 'save': // pi only : upsert dans le mcp.json du scope (pi n'a pas de `pi mcp add`)
        if (!isPi) return fail(400, 'save is pi-only');
        return json(saveMcpPi({ cwd, scope, name, config }));
      case 'remove':
        if (!isPi) return fail(400, 'remove is pi-only');
        return json(removeMcpPi({ cwd, scope, name }));
      case 'migrate-legacy': // pi : [[mcp.servers]] de l'ancien ~/.pi/config.toml → ~/.pi/agent/mcp.json
        if (!isPi) return fail(400, 'migrate-legacy is pi-only');
        return json(migrateLegacyToml({ cwd }));
      case 'logout':
        if (!name) return fail(400, 'name required');
        return json({ ok: true, ...(await logoutMcp(cwd, name, profile)) });
      case 'login':
        if (!name) return fail(400, 'name required');
        return json({ ok: true, login: await startLogin(cwd, name, profile) });
      case 'login-status': {
        const st = loginStatus(id);
        return st ? json({ ok: true, login: st }) : fail(404, 'unknown login');
      }
      case 'login-input': {
        const st = sendLoginInput(id, text);
        return st ? json({ ok: true, login: st }) : fail(404, 'unknown login');
      }
      case 'login-cancel': {
        const st = cancelLogin(id);
        return st ? json({ ok: true, login: st }) : fail(404, 'unknown login');
      }
      default:
        return fail(400, 'unknown action');
    }
  } catch (e) {
    return fail(500, e && e.message ? e.message : 'mcp command failed');
  }
}
