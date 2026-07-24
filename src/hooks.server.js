import { dev } from '$app/environment';
import { startDigestScheduler } from '$lib/server/core.js';

// Server-init side effects. The daily-digest scheduler is prod-only: in dev (`npm run live`) we
// don't want a boot to spawn `claude -p` against the live transcripts.
if (!dev) startDigestScheduler();
