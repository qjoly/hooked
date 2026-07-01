import { json } from '@sveltejs/kit';
import { buildBackgroundView } from '$lib/server/core.js';

// Vue globale des jobs de fond encore actifs (Bash run_in_background / Monitor / ScheduleWakeup),
// toutes sessions au pane vivant. Alimente la carte « Active background jobs » de l'Overview.
export function GET() {
  return json({ ...buildBackgroundView(), now: new Date().toISOString() });
}
