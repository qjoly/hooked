import { json } from '@sveltejs/kit';
import { readClaudeDefaults } from '$lib/server/core.js';

// Défauts modèle/effort pour le sélecteur « Nouvelle session », relus depuis ~/.claude à
// chaque appel (cf. readClaudeDefaults) — pas de cache, pour rester synchrone avec Claude Code.
export function GET() {
  return json(readClaudeDefaults());
}
