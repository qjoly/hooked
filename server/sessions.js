/*
 * Point d'entrée unique pour le scan des sessions, tous providers confondus
 * (cf. docs/port-pi.md) : Claude Code (transcripts ~/.claude/projects) + pi
 * (fichiers .jsonl sous ~/.pi/agent/sessions). Même shape de retour (blankSummary + `provider`).
 */
import { scanSessions } from './transcript.js';
import { scanPiSessions } from './pi.js';

function scanAllSessions(projectsDir, piSessionsDir) {
  return [...scanSessions(projectsDir), ...scanPiSessions(piSessionsDir)];
}

// Résout UNE session par id, tous providers confondus. Règle S1 (cf. PLAN_migration_mistral.md) :
// toute route/module qui reçoit un `id` de session passe par ici, jamais par scanSessions() seul —
// sinon une session pi est 404 alors que la route n'a besoin que de `s.project` / `s.dir`.
function findSessionAny(id, projectsDir, piSessionsDir) {
  if (!id) return null;
  return scanAllSessions(projectsDir, piSessionsDir).find((x) => x.id === id) || null;
}

export { scanAllSessions, findSessionAny };
