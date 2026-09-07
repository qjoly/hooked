import { json } from '@sveltejs/kit';
import {
  listMcp, getMcp, logoutMcp, startLogin, loginStatus, sendLoginInput, cancelLogin,
} from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// MCP servers of a project: health-checked list + scope + config diagnostics.
// `cwd` matters — project and local scopes are per-directory (see server/mcp.js).
export async function GET({ url }) {
  return json(await listMcp(url.searchParams.get('cwd')));
}

// Everything that mutates or blocks: OAuth login (start / poll / paste back / cancel), logout,
// and the per-server detail read, which costs its own health-checked spawn.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.action !== 'string') return fail(400, 'action required');
  const { action, cwd, name, id, text } = body;
  try {
    switch (action) {
      case 'get':
        if (!name) return fail(400, 'name required');
        return json({ ok: true, ...(await getMcp(cwd, name)) });
      case 'logout':
        if (!name) return fail(400, 'name required');
        return json({ ok: true, ...(await logoutMcp(cwd, name)) });
      case 'login':
        if (!name) return fail(400, 'name required');
        return json({ ok: true, login: await startLogin(cwd, name) });
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
