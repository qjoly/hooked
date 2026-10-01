import { json } from '@sveltejs/kit';
import {
  accountInfo, invalidateStatus, startAccountLogin, accountLoginStatus, sendAccountLoginInput,
  cancelAccountLogin, accountLogout,
  listRosterAccounts, saveCurrentAccountToRoster, switchToRosterAccount, removeRosterAccount,
  renameRosterAccount,
} from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Who is currently signed in (top bar avatar/menu): merged `claude auth status` + ~/.claude.json.
// `?force=1` bypasses the 5-minute cache — used when the modal opens / the tab regains focus,
// moments where a stale identity is actually likely to mislead (someone signed in from elsewhere).
export async function GET({ url }) {
  if (url.searchParams.get('force')) invalidateStatus();
  return json(await accountInfo());
}

// Switching accounts: start/poll/paste-back/cancel the `claude auth login` PTY flow, logout, or
// the roster actions (list/save/switch/remove/rename saved accounts — no PTY involved).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.action !== 'string') return fail(400, 'action required');
  const { action, id, text, mode, label } = body;
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
      case 'roster-list':
        return json({ ok: true, accounts: await listRosterAccounts() });
      case 'roster-save':
        return json({ ok: true, account: await saveCurrentAccountToRoster(label) });
      case 'roster-switch':
        return json({ ok: true, account: await switchToRosterAccount(id) });
      case 'roster-remove':
        return removeRosterAccount(id) ? json({ ok: true }) : fail(404, 'unknown saved account');
      case 'roster-rename': {
        const entry = renameRosterAccount(id, label);
        return entry ? json({ ok: true, account: entry }) : fail(404, 'unknown saved account');
      }
      default:
        return fail(400, 'unknown action');
    }
  } catch (e) {
    return fail(500, e && e.message ? e.message : 'account command failed');
  }
}
