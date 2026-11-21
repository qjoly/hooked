import { json } from '@sveltejs/kit';
import { piOptions } from '#lib/server/core.js';

// Options de lancement pour le provider pi (catalogue `pi --list-models mistral`) :
// modèles, thinking levels, modes (pi n'a qu'un mode « auto » en RPC). Utilisé par l'écran
// « Nouvelle session » quand le provider sélectionné est « pi ».
export async function GET() {
  return json(await piOptions());
}
