import { dev } from '$app/environment';
import { startDigestScheduler, startRemoteControl, readSettings, resumeDrivenSessions, startDrivenSnapshot } from '$lib/server/core.js';

// Server-init side effects, prod-only: in dev (`npm run live`) we don't want a boot to spawn claude
// processes against the live environment — the daily-digest scheduler (`claude -p`) nor the
// remote-control daemons (`claude --remote-control`, reconciled to settings.remoteControlProjects).
if (!dev) {
  startDigestScheduler();
  startRemoteControl(readSettings());
  // Sessions live in this process, so a restart kills them all. Bring back the ones that were being
  // driven when we last stopped, then keep the snapshot current for the next restart.
  resumeDrivenSessions();
  startDrivenSnapshot();
}
