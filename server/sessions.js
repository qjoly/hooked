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

export { scanAllSessions };
