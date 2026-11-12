package dev.qjoly.hooked

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ServiceCompat
import java.net.HttpURLConnection
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Follows the dashboard's event stream, like the desktop app's menu bar icon, so notifications keep
 * coming with the app in the background. Runs only while notifications are on in the settings.
 */
class WatchService : Service() {
    companion object {
        private const val TAG = "hooked"

        /** The stream ticks every 4 s at least, and the session list weighs a few hundred KB. */
        private const val MIN_GAP_MS = 10_000L
        private const val MAX_BACKOFF_MS = 60_000L

        /** The app is on screen and already shows what changed, so no popups. */
        @Volatile var appVisible = false

        fun sync(ctx: Context) {
            val intent = Intent(ctx, WatchService::class.java)
            val wanted = ServerConfig.load(ctx) != null && AppPrefs.notify(ctx) && Notify.allowed(ctx)
            if (!wanted) {
                ctx.stopService(intent)
                return
            }
            // Refused when the app is not in the foreground; the next resume tries again.
            runCatching { ctx.startForegroundService(intent) }.onFailure { Log.w(TAG, "watcher not started", it) }
        }

        /** After a server change: the stream is followed on the old host until then. */
        fun restart(ctx: Context) {
            ctx.stopService(Intent(ctx, WatchService::class.java))
            sync(ctx)
        }
    }

    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var follower: Thread? = null
    @Volatile private var stopped = false
    @Volatile private var stream: HttpURLConnection? = null

    // Touched on the worker thread only, except `shown`, also read when the service restarts.
    private val tracker = Tracker()
    private var pending: ScheduledFuture<*>? = null
    private var lastRefresh = 0L
    @Volatile private var shown: Status? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notify.channels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val cfg = ServerConfig.load(this)
        val status = shown ?: Status.Connecting(cfg?.base.orEmpty())
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        // Every startForegroundService() owes a startForeground(), even on a running service.
        val started = runCatching { ServiceCompat.startForeground(this, Notify.STATUS_ID, Notify.status(this, status), type) }
        if (started.isFailure || cfg == null) {
            Log.w(TAG, "watcher stopping", started.exceptionOrNull())
            stopSelf()
            return START_NOT_STICKY
        }
        if (follower == null) follower = Thread(::follow, "hooked-stream").apply { isDaemon = true; start() }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        runCatching { stream?.disconnect() }
        follower?.interrupt()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun follow() {
        var backoff = 3_000L
        while (!stopped) {
            val cfg = ServerConfig.load(this) ?: break
            try {
                // Longer than the stream's 4 s heartbeat, so a silent connection is a dead one.
                val c = Api.open("${cfg.base}/api/stream", 30_000)
                stream = c
                c.inputStream.bufferedReader().use { r ->
                    backoff = 3_000L
                    poke()
                    while (!stopped) {
                        val line = r.readLine() ?: break
                        if (line.startsWith("data:")) poke()
                    }
                }
            } catch (e: Exception) {
                if (!stopped) publishOnWorker(Status.Unreachable(cfg.base))
            } finally {
                stream?.disconnect()
                stream = null
            }
            if (stopped) break
            try {
                Thread.sleep(backoff)
            } catch (_: InterruptedException) {
                break
            }
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    /** One refresh per gap at most, the trailing tick included. */
    private fun poke() = runCatching {
        worker.execute {
            if (pending != null) return@execute
            val wait = (lastRefresh + MIN_GAP_MS - SystemClock.elapsedRealtime()).coerceAtLeast(0)
            pending = worker.schedule({ pending = null; refresh() }, wait, TimeUnit.MILLISECONDS)
        }
    }

    private fun refresh() {
        lastRefresh = SystemClock.elapsedRealtime()
        val cfg = ServerConfig.load(this) ?: return
        val all = try {
            Api.sessions(cfg)
        } catch (e: Exception) {
            Log.w(TAG, "session list failed", e)
            publish(Status.Unreachable(cfg.base))
            return
        }
        val pass = tracker.update(all, System.currentTimeMillis())
        if (!appVisible) pass.fresh.forEach { (s, k) -> Notify.session(this, s, k) }
        pass.cleared.forEach { Notify.cancelSession(this, it) }
        publish(Status.Live(cfg.base, pass.waiting))
    }

    private fun publishOnWorker(status: Status) = runCatching { worker.execute { publish(status) } }

    private fun publish(status: Status) {
        if (stopped || status == shown) return
        shown = status
        getSystemService(NotificationManager::class.java).notify(Notify.STATUS_ID, Notify.status(this, status))
    }
}
