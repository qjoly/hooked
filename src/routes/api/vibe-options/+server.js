import { json } from '@sveltejs/kit';
import { vibeOptions } from '#lib/server/core.js';

// Options de lancement pour le provider Mistral Vibe (lus dans ~/.vibe/config.toml) :
// modèles (alias), thinking levels, agents (modes de permission). Utilisé par l'écran
// « Nouvelle session » quand le provider sélectionné est « vibe ».
export async function GET() {
  return json(vibeOptions());
}
