/*
 * Removing a connection profile from the account menu ("Remove").
 *
 * What it does, in this order, and what it deliberately leaves alone:
 *   1. refuses while a driven session is running on the profile: it would keep going, but could not be
 *      resumed or restarted afterwards, since its profile would be gone;
 *   2. ends the sign-ins still open for the account;
 *   3. signs the account out, when the profile has one of its own (best effort: the CLI deletes the
 *      login, a Keychain item included; if that fails the entry is removed all the same and the
 *      result says so, since keeping an unreachable profile around helps nobody);
 *   4. takes the entry out of profiles.json, and forgets it as the default account if it was;
 *   5. KEEPS the account's directory on disk, and says where. It holds the account's own config and
 *      MCP servers, and hooked never deletes a directory that held a login.
 *
 * The side effects come in through `deps`, so the order and the refusals are tested without a CLI.
 *
 * Node stdlib only.
 */
import { findProfile, DEFAULT_PROFILE_ID } from './profiles.js';
import { removeProfileEntry } from './profilesFile.js';

/**
 * @param {string} id
 * @param {object} deps
 *   find(id)            → profile | null
 *   liveSessionsOn(id)  → number of driven sessions running on it
 *   cancelLogins(id)    → void
 *   logout(id)          → Promise<{ ok, message }>
 *   removeEntry(id)     → { removed } | { error }
 *   clearDefault(id)    → void: forget it as the default account when it was
 * @returns {Promise<{ removed: true, loggedOut: boolean|null, keptDir: string|null } | { error: string }>}
 */
export async function removeProfile(id, deps) {
  if (typeof id !== 'string' || !id || id === DEFAULT_PROFILE_ID) return { error: 'the main account cannot be removed' };
  const profile = deps.find(id);
  if (!profile) return { error: 'unknown profile' };

  const running = deps.liveSessionsOn(id);
  if (running > 0) {
    return { error: `${running} session${running > 1 ? 's are' : ' is'} running on it. Stop ${running > 1 ? 'them' : 'it'} first.` };
  }

  let loggedOut = null; // null: nothing to sign out (a server, or an account that is not signed in)
  if (profile.configDir) {
    deps.cancelLogins(id);
    try {
      const r = await deps.logout(id);
      loggedOut = !!(r && r.ok);
    } catch (_) {
      loggedOut = false;
    }
  }

  const r = deps.removeEntry(id);
  if (r.error) return { error: r.error };
  deps.clearDefault(id);
  return { removed: true, loggedOut, keptDir: profile.configDir || null };
}

// The real dependencies. Imported lazily: agent.js and account.js load the CLI machinery.
export async function removeProfileForReal(id) {
  const [{ liveSessionIds, profileOfSession }, { accountLogout, cancelAccountLoginsFor }, { readSettings, writeSettings }] = await Promise.all([
    import('./agent.js'), import('./account.js'), import('./settings.js'),
  ]);
  return removeProfile(id, {
    find: (pid) => findProfile(pid),
    liveSessionsOn: (pid) => liveSessionIds().filter((sid) => profileOfSession(sid) === pid).length,
    cancelLogins: (pid) => cancelAccountLoginsFor(pid),
    logout: (pid) => accountLogout(pid),
    removeEntry: (pid) => removeProfileEntry(pid),
    clearDefault: (pid) => { if (readSettings().defaultProfile === pid) writeSettings({ defaultProfile: '' }); },
  });
}
