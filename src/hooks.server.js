import { dev } from '$app/environment';
import { startDigestScheduler, startRemoteControl, readSettings, resumeDrivenSessions, startDrivenSnapshot, installShutdownHook } from '$lib/server/core.js';

// Ctrl+C has to actually stop the process. adapter-node closes the HTTP listener on SIGINT but
// never exits, so any handle left behind (fs watchers, driven subprocesses, PTYs) keeps hooked
// alive with a dead dashboard. Installed in dev too: the handles are the same there.
installShutdownHook();

// Server-init side effects. Skipped for an AD HOC `npm run live`/`npm run dev` (a developer
// hacking on hooked itself) — we don't want that boot spawning claude processes against the live
// environment: the daily-digest scheduler (`claude -p`), the remote-control daemons, or resuming
// driven sessions. But NOT skipped for the actual installed service running in dev mode
// (`service-install --dev` — e.g. a stopgap while the prod build is broken on some machine): that
// IS the real, persistent hooked instance, and its driven sessions still need to survive a restart
// same as prod's. `HOOKED_MODE` is only ever set by deploy/service-run.sh (baked into the launchd
// plist/systemd unit at `service-install` time, prod or dev) — its presence is exactly the signal
// that this is the service, not a bare terminal `npm run live`.
if (!dev || process.env.HOOKED_MODE) {
  startDigestScheduler();
  startRemoteControl(readSettings());
  // Sessions live in this process, so a restart kills them all. Bring back the ones that were being
  // driven when we last stopped, then keep the snapshot current for the next restart.
  resumeDrivenSessions();
  startDrivenSnapshot();
}
