/*
 * The directory of a profile's own Claude account (`configDir`, cf. server/profiles.js).
 *
 * Pointing CLAUDE_CONFIG_DIR at a fresh directory gives the CLI a separate login, but also a bare
 * config: no hooks, no skills, no CLAUDE.md, and transcripts written where hooked does not read
 * them. So the parts that are not about WHO is signed in are linked to the default account's
 * directory: one set of hooks, skills and settings, and one `projects/` for hooked to scan.
 *
 * Deliberately NOT linked: `.claude.json` (the identity, and the user-scope MCP servers: those are
 * what makes an account its own) and `.credentials.json` (the login). Anything that already exists
 * in the account dir is left as it is, never replaced: it may be the account's own on purpose.
 *
 * The directory ends up private whoever created it first: it holds a login, and the CLI itself
 * creates a missing config dir with the default permissions (755) the first time it is run on it,
 * even for a read-only `auth status`. So an existing directory is tightened to 700, never loosened.
 *
 * Idempotent, and cheap enough to run before every launch. Node stdlib only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mainConfigDir } from './profiles.js';

// Shared with the default account. `projects` first: hooked cannot see a session without it.
export const SHARED_ENTRIES = ['projects', 'settings.json', 'CLAUDE.md', 'skills', 'commands', 'agents', 'plugins'];

const lstat = (p) => { try { return fs.lstatSync(p); } catch (_) { return null; } };

/**
 * Creates the account dir (private: it holds a login) and links the shared entries into it.
 * Returns { dir, linked, kept, missing } (names), or { error }:
 *   linked  linked now, or already linked to the right place
 *   kept    already there as something else: left alone
 *   missing the default account has none of it: nothing to link
 */
export function prepareAccountDir(profile, { mainDir = mainConfigDir() } = {}) {
  const dir = profile && profile.configDir;
  if (!dir) return { error: 'this profile has no configDir' };
  if (dir === mainDir) return { error: 'refusing to prepare the default account\'s own directory' };
  const linked = [], kept = [], missing = [];
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // The transcripts have to land somewhere hooked reads, so this one is created if need be.
    fs.mkdirSync(path.join(mainDir, 'projects'), { recursive: true });
    for (const name of SHARED_ENTRIES) {
      const src = path.join(mainDir, name);
      const dest = path.join(dir, name);
      const existing = lstat(dest);
      if (existing) {
        const same = existing.isSymbolicLink() && fs.readlinkSync(dest) === src;
        (same ? linked : kept).push(name);
        continue;
      }
      if (!lstat(src)) { missing.push(name); continue; }
      fs.symlinkSync(src, dest);
      linked.push(name);
    }
  } catch (e) {
    return { error: `cannot prepare ${dir}: ${(e && e.message) || e}` };
  }
  return { dir, linked, kept, missing };
}
