/**
 * Graceful shutdown of the hooked process.
 *
 * `adapter-node` registers its own SIGINT/SIGTERM handlers, closes the HTTP listener and NEVER
 * calls `process.exit` — Node's default termination is therefore suppressed, and the process only
 * exits once the event loop drains on its own. Measured on the built server, reading
 * `process.getActiveResourcesInfo()` right after the signal: two `FSEventWrap` handles were left,
 * the `fs.watch` calls behind the SSE stream, and the process survived Ctrl+C indefinitely — the
 * dashboard was unreachable (listener closed) but it still took a `kill -9`. Driven sessions'
 * subprocesses (piped stdio) and the PTYs of terminals and MCP logins hold the loop the same way.
 *
 * So we release everything by hand, in this order, then let the loop drain.
 */
import { liveSessionIds, killSession, saveDriven } from './agent.js';
import { closeTerminalsFor } from './terminal.js';
import { cancelAllLogins } from './mcp.js';

// Registries pinned on globalThis, same reason as the session and terminal ones: Vite's module
// re-execution in `npm run live` would reinstall the handler and lose already-registered callbacks.
const HOOKS = Symbol.for('hooked.shutdown.hooks');
const INSTALLED = Symbol.for('hooked.shutdown.installed');
const hooks = globalThis[HOOKS] || (globalThis[HOOKS] = new Set());

const EXIT_GRACE_MS = 3000;

/**
 * Registers a callback to run at shutdown. It exists for handles `server/*` knows nothing about:
 * the fs watchers and SSE clients live in `$lib/server/live.js`, on the SvelteKit side, which
 * registers itself rather than being imported here (the other direction would be a backwards
 * dependency). Returns the unregister function.
 */
export function onShutdown(fn) {
  if (typeof fn !== 'function') return () => {};
  hooks.add(fn);
  return () => hooks.delete(fn);
}

/**
 * Releases everything that holds the event loop. `exitGraceMs: 0` skips arming the exit net — tests
 * call this in a process that has to survive it.
 */
export function shutdownNow({ exitGraceMs = EXIT_GRACE_MS } = {}) {
  const freed = { sessions: 0, terminals: 0, logins: 0, hooks: 0 };

  // Snapshot first: the next boot's resume reads it, and the 10s poll can be one registry mutation
  // behind.
  try { saveDriven(); } catch (_) {}

  // Then the sessions. `killSession` closes the input queue and aborts, which lets `readLoop`
  // release a pending `canUseTool` promise — otherwise the subprocess stays blocked on the way out.
  for (const id of liveSessionIds()) {
    try { killSession(id, () => {}); freed.sessions++; } catch (_) {}
  }

  try { freed.terminals = closeTerminalsFor() || 0; } catch (_) {}
  try { freed.logins = cancelAllLogins() || 0; } catch (_) {}

  for (const fn of [...hooks]) {
    try { fn(); freed.hooks++; } catch (_) {}
  }

  // Net: should a handle resist anyway, we don't leave the process lingering forever. The timer is
  // `unref()`ed, so it never holds the loop itself and only fires if something else still does. An
  // empty loop exits naturally, before the deadline.
  if (exitGraceMs > 0) setTimeout(() => process.exit(0), exitGraceMs).unref();

  return freed;
}

/** Wires SIGINT/SIGTERM. Idempotent: two imports install a single handler. */
export function installShutdownHook() {
  if (globalThis[INSTALLED]) return false;
  globalThis[INSTALLED] = true;
  let firing = false;
  const handler = () => {
    // A second Ctrl+C while shutting down: don't make anyone wait, just leave.
    if (firing) return process.exit(0);
    firing = true;
    shutdownNow();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return true;
}
