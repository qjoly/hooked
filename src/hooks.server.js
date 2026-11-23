import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import { dev } from '$app/env';
import { startDigestScheduler, startCronScheduler, startRemoteControl, readSettings, resumeDrivenSessions, startDrivenSnapshot, installShutdownHook, startWarmupScheduler, startAutoCompactScheduler, applyGitSyncSetting, applyPrReviewTagSetting, applyAutoTagSetting, startPrWatch, startWorktreeCleanup, startAutoPull, loadExternalEngines, startFlowEngine } from '#lib/server/core.js';

const gzip = promisify(gzipCb);

// Ctrl+C has to actually stop the process. adapter-node closes the HTTP listener on SIGINT but
// never exits, so any handle left behind (fs watchers, driven subprocesses, PTYs) keeps hooked
// alive with a dead dashboard. Installed in dev too: the handles are the same there.
installShutdownHook();

// External provider engines (modules in HOOKED_PROVIDERS_DIR, default ~/.claude/hooked/providers):
// loaded in every deployment so their providers show up; driven sessions are resumed after it.
const enginesReady = loadExternalEngines().catch(() => {});

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
  startCronScheduler();
  startRemoteControl(settings);
  // Settings-driven background loops (git sync of hooked's own checkout, PR review tags). They used
  // to start from GET /api/settings, i.e. only once a browser had loaded the page — a service nobody
  // opened a browser on never ran them. Idempotent; POST /api/settings re-applies them on change.
  applyGitSyncSetting(settings);
  applyPrReviewTagSetting(settings);
  applyAutoTagSetting(settings);
  // Sessions live in this process, so a restart kills them all. Bring back the ones that were being
  // driven when we last stopped, then keep the snapshot current for the next restart.
  // A session of an external provider can only resume once its engine module is loaded.
  enginesReady.finally(() => resumeDrivenSessions());
  startDrivenSnapshot();
  // Flow runs in progress: their stage sessions come back through the resume above.
  startFlowEngine({ adopt: true });
  startWorktreeCleanup();
  startAutoPull();
}

// The 5h-window scheduler runs whatever the deployment (an ad hoc `npm run live` included): it is
// a no-op until the feature is switched on, and every tick re-reads the setting. POST /api/settings
// re-plans it immediately on change.
startWarmupScheduler();
// Same reasons for auto-compact (settings → autoCompact): every tick reads the setting.
startAutoCompactScheduler();
// PR watches only wake sessions driven by this process, and autoPrWatch is read on every tick.
startPrWatch();

// adapter-node does not compress responses, and the dashboard polls JSON that is mostly repetitive
// text (transcripts, file changes): gzip turns several MB per refresh into a few hundred KB, which
// matters as soon as hooked is viewed over Wi-Fi. SSE streams are left alone (they must flush).
const MIN_COMPRESS = 1024;
export async function handle({ event, resolve }) {
  const response = await resolve(event);
  if (!event.url.pathname.startsWith('/api/')) return response;
  if (response.status === 304 || !response.body || response.headers.has('content-encoding')) return response;
  if (!/\bgzip\b/.test(event.request.headers.get('accept-encoding') || '')) return response;
  if (!/^application\/json/.test(response.headers.get('content-type') || '')) return response;
  const raw = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Accept-Encoding');
  if (raw.length < MIN_COMPRESS) return new Response(raw, { status: response.status, headers });
  const body = await gzip(raw, { level: 5 });
  headers.set('Content-Encoding', 'gzip');
  headers.set('Content-Length', String(body.length));
  // A compressed body is a different representation: keep the validator weak so it still matches.
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/')) headers.set('ETag', 'W/' + etag);
  return new Response(body, { status: response.status, headers });
}
