import { json } from '@sveltejs/kit';
import {
  accountInfo, startAccountLogin, accountLoginStatus, sendAccountLoginInput, cancelAccountLogin,
  accountLogout,
} from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Who is currently signed in (top bar avatar/menu): merged `claude auth status` + ~/.claude.json.
export async function GET() {
  return json(await accountInfo());
}

// Switching accounts: start/poll/paste-back/cancel the `claude auth login` PTY flow, or logout.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.action !== 'string') return fail(400, 'action required');
  const { action, id, text, mode } = body;
  try {
    switch (action) {
      case 'login':
        return json({ ok: true, login: await startAccountLogin(mode) });
      case 'login-status': {
        const st = accountLoginStatus(id);
        return st ? json({ ok: true, login: st }) : fail(404, 'unknown login');
      }
      case 'login-input': {
        const st = sendAccountLoginInput(id, text);
        return st ? json({ ok: true, login: st }) : fail(404, 'unknown login');
      }
      case 'login-cancel': {
        const st = cancelAccountLogin(id);
        return st ? json({ ok: true, login: st }) : fail(404, 'unknown login');
      }
      case 'logout':
        return json({ ok: true, ...(await accountLogout()) });
      default:
        return fail(400, 'unknown action');
    }
  } catch (e) {
    return fail(500, e && e.message ? e.message : 'account command failed');
  }
}
