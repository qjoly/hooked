import { json } from '@sveltejs/kit';
import { warmupStatus, runWarmupNow } from '$lib/server/core.js';
import { fail } from '$lib/server/respond.js';

// 5h-window management (cf. server/warmup.js). GET = the day's planned windows + why the scheduler
// is (not) about to ping right now. POST = ping immediately, bypassing the "window already open"
// guard, so the premise can be checked by hand: watch the 5h gauge's reset time move.
export function GET() {
  return json(warmupStatus());
}

export async function POST() {
  try {
    return json({ ok: true, ...(await runWarmupNow()) }); // jpost() gates on a top-level ok
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
