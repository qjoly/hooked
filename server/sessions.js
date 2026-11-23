/*
 * Single entry point for the session scan, every provider included (cf. server/providers.js):
 * Claude Code transcripts, pi session files, journals of ACP / external providers. Same return
 * shape for all (blankSummary + `provider` + `engine`).
 */
import { scanSessions } from './transcript.js';
import { scanPiSessions } from './pi.js';
import { scanProviderSessions } from './providers.js';

// Explicit folders (tests, the search index pointed at a fixture) keep the historical two-store
// scan; the normal call goes through the provider registry.
function scanAllSessions(projectsDir, piSessionsDir) {
  if (projectsDir !== undefined || piSessionsDir !== undefined) {
    const tag = (engine) => (s) => { s.provider = s.provider || engine; s.engine = engine; return s; };
    return [...scanSessions(projectsDir).map(tag('claude')), ...scanPiSessions(piSessionsDir).map(tag('pi'))];
  }
  return scanProviderSessions();
}

// Resolves ONE session by id, every provider included. Rule S1 (cf. PLAN_migration_mistral.md):
// every route / module receiving a session `id` goes through here, never through scanSessions()
// alone — otherwise a non-Claude session is a 404 although the route only needs `s.project`.
function findSessionAny(id, projectsDir, piSessionsDir) {
  if (!id) return null;
  return scanAllSessions(projectsDir, piSessionsDir).find((x) => x.id === id) || null;
}

export { scanAllSessions, findSessionAny };
