/*
 * Point d'entrée unique pour le scan des sessions, tous providers confondus
 * (cf. docs/port-vibe.md) : Claude Code (transcripts ~/.claude/projects) + Mistral Vibe
 * (dossiers ~/.vibe/logs/session/unified). Même shape de retour (blankSummary + `provider`).
 */
import { scanSessions } from './transcript.js';
import { scanVibeSessions } from './vibe.js';

function scanAllSessions(projectsDir, vibeSessionsDir) {
  return [...scanSessions(projectsDir), ...scanVibeSessions(vibeSessionsDir)];
}

// Résout UNE session par id, tous providers confondus. Règle S1 (cf. PLAN_migration_mistral.md) :
// toute route/module qui reçoit un `id` de session passe par ici, jamais par scanSessions() seul —
// sinon une session vibe est 404 alors que la route n'a besoin que de `s.project` / `s.dir`.
function findSessionAny(id, projectsDir, vibeSessionsDir) {
  if (!id) return null;
  return scanAllSessions(projectsDir, vibeSessionsDir).find((x) => x.id === id) || null;
}

export { scanAllSessions, findSessionAny };
