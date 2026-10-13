/*
 * Plugins and marketplaces, managed from the dashboard: the `/plugin` TUI screen rebuilt on the
 * CLI's non-interactive `claude plugin` subcommands (same reason as server/mcp.js). Unlike
 * `claude mcp list`, `claude plugin list` has a JSON mode, so there is no text parsing here.
 */
import { resolveClaudeBin } from './commands.js';
import { runClaude, validCwd, stripCliAnsi } from './mcp.js';

const ACTION_TIMEOUT_MS = 120_000; // install / marketplace add clone git repos
const SCOPES = new Set(['user', 'project', 'local']);
const PLUGIN_ID = /^\w[\w.-]*(@\w[\w.-]*)?$/;

// The CLI does not check that the plugin exists for these: `enable foo@nowhere` "succeeds" and
// writes the bogus id into enabledPlugins. They must target an installed plugin.
const NEEDS_INSTALLED = new Set(['uninstall', 'enable', 'disable', 'update']);

/**
 * argv for a plugin action. `--` ends the options, so a value starting with `-` stays positional.
 * Throws on anything the dashboard has no business sending.
 */
export function pluginArgs(action, { id, scope, source } = {}) {
  if (scope != null && !SCOPES.has(scope)) throw new Error(`invalid scope: ${scope}`);
  const sc = scope ? ['--scope', scope] : [];
  const needId = () => {
    if (typeof id !== 'string' || !PLUGIN_ID.test(id)) throw new Error('invalid plugin id');
    return id;
  };
  switch (action) {
    case 'install':
    case 'uninstall':
    case 'enable':
    case 'disable':
    case 'update':
      return ['plugin', action, ...sc, '--', needId()];
    case 'marketplace-add': {
      const src = typeof source === 'string' ? source.trim() : '';
      if (!src || src.length > 2048) throw new Error('invalid marketplace source');
      return ['plugin', 'marketplace', 'add', ...sc, '--', src];
    }
    case 'marketplace-remove':
      return ['plugin', 'marketplace', 'remove', ...sc, '--', needId()];
    case 'marketplace-update':
      return ['plugin', 'marketplace', 'update', ...(id ? ['--', needId()] : [])];
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

// stdout only: a warning on stderr must not break the JSON.
function parseJson(res, what) {
  if (!res.ok) throw new Error(`${what} failed: ${stripCliAnsi(res.out).trim() || `exit ${res.code}`}`);
  try { return JSON.parse(res.stdout); } catch (_) { throw new Error(`${what}: unreadable JSON`); }
}

/** Installed plugins + configured marketplaces, plus the marketplaces' catalog with `available`. */
export async function listPlugins(cwd, { available = false } = {}) {
  const dir = validCwd(cwd);
  if (!resolveClaudeBin()) return { cwd: dir, installed: [], marketplaces: [], error: 'claude binary not found' };
  const [plugins, markets] = await Promise.all([
    runClaude(['plugin', 'list', '--json', ...(available ? ['--available'] : [])], dir),
    runClaude(['plugin', 'marketplace', 'list', '--json'], dir),
  ]);
  try {
    const p = parseJson(plugins, 'plugin list');
    return {
      cwd: dir,
      installed: available ? p.installed || [] : p,
      ...(available ? { available: p.available || [] } : {}),
      marketplaces: parseJson(markets, 'marketplace list'),
    };
  } catch (e) {
    return { cwd: dir, installed: [], marketplaces: [], error: e.message };
  }
}

export async function runPluginAction(cwd, action, opts = {}) {
  const dir = validCwd(cwd);
  const args = pluginArgs(action, opts);
  if (NEEDS_INSTALLED.has(action)) {
    const { installed, error } = await listPlugins(dir);
    if (error) throw new Error(error);
    if (!installed.some((p) => p.id === opts.id)) throw new Error(`plugin not installed: ${opts.id}`);
  }
  const { ok, out } = await runClaude(args, dir, ACTION_TIMEOUT_MS);
  return { ok, message: stripCliAnsi(out).trim() };
}
