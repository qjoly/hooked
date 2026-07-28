import { dev } from '$app/environment';
import { startDigestScheduler, startRemoteControl, readSettings } from '$lib/server/core.js';

// Server-init side effects, prod-only: in dev (`npm run live`) we don't want a boot to spawn claude
// processes against the live environment — the daily-digest scheduler (`claude -p`) nor the
// remote-control daemons (`claude --remote-control`, reconciled to settings.remoteControlProjects).
if (!dev) {
  startDigestScheduler();
  startRemoteControl(readSettings());
}
