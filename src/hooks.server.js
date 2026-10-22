import { dev } from '$app/environment';
import { startDigestScheduler, startRemoteControl, readSettings, resumeDrivenSessions, startDrivenSnapshot, installShutdownHook, startWarmupScheduler, startAutoCompactScheduler, applyGitSyncSetting, applyPrReviewTagSetting, applyAutoTagSetting } from '$lib/server/core.js';

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
  const settings = readSettings();
  startDigestScheduler();
  startRemoteControl(settings);
  // Settings-driven background loops (git sync of hooked's own checkout, PR review tags). They used
  // to start from GET /api/settings, i.e. only once a browser had loaded the page — a service nobody
  // opened a browser on never ran them. Idempotent; POST /api/settings re-applies them on change.
  applyGitSyncSetting(settings);
  applyPrReviewTagSetting(settings);
  applyAutoTagSetting(settings);
  // Sessions live in this process, so a restart kills them all. Bring back the ones that were being
  // driven when we last stopped, then keep the snapshot current for the next restart.
  resumeDrivenSessions();
  startDrivenSnapshot();
}

// The 5h-window scheduler runs whatever the deployment (an ad hoc `npm run live` included): it is
// a no-op until the feature is switched on, and every tick re-reads the setting. POST /api/settings
// re-plans it immediately on change.
startWarmupScheduler();
// Same reasons for auto-compact (settings → autoCompact): every tick reads the setting.
startAutoCompactScheduler();
