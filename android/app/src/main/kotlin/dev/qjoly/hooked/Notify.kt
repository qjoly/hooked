package dev.qjoly.hooked

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/** What the ongoing notification says: the Android stand-in for the desktop menu bar count. */
sealed interface Status {
    data class Connecting(val base: String) : Status
    data class Unreachable(val base: String) : Status
    data class Live(val base: String, val waiting: List<Pair<SessionInfo, Kind>>) : Status
}

object Notify {
    private const val STATUS_CHANNEL = "status"
    private const val SESSIONS_CHANNEL = "sessions"
    const val STATUS_ID = 1
    private const val SESSION_ID = 2
    private const val TAG_PREFIX = "session:"
    const val EXTRA_SESSION = "session"

    fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun channels(ctx: Context) {
        manager(ctx).createNotificationChannels(listOf(
            NotificationChannel(STATUS_CHANNEL, "Waiting count", NotificationManager.IMPORTANCE_LOW).apply {
                description = "How many sessions wait on you, while background notifications are on."
                setShowBadge(false)
            },
            NotificationChannel(SESSIONS_CHANNEL, "Sessions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A session that starts waiting on you, while the app is not on screen."
            },
        ))
    }

    fun status(ctx: Context, status: Status): Notification {
        val b = Notification.Builder(ctx, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hook)
            .setColor(ctx.getColor(R.color.accent))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(open(ctx, null))
        when (status) {
            is Status.Connecting -> b.setContentTitle("Connecting to hooked").setContentText(status.base)
            is Status.Unreachable -> b.setContentTitle("hooked is not answering").setContentText("Retrying ${status.base}")
            is Status.Live -> {
                val n = status.waiting.size
                if (n == 0) {
                    b.setContentTitle("Nothing waiting on you").setContentText(status.base)
                } else {
                    b.setContentTitle(if (n == 1) "1 session waiting on you" else "$n sessions waiting on you")
                        .setContentText(status.waiting.joinToString(", ") { it.first.title })
                        .setNumber(n)
                    val inbox = Notification.InboxStyle()
                    status.waiting.take(6).forEach { (s, k) -> inbox.addLine("${k.icon} ${s.title} — ${k.label}") }
                    if (n > 6) inbox.setSummaryText("+${n - 6} more")
                    b.setStyle(inbox)
                }
            }
        }
        return b.build()
    }

    /** Same wording as the dashboard's own popups (fireNotification in state.svelte.js). */
    fun session(ctx: Context, s: SessionInfo, kind: Kind) {
        val n = Notification.Builder(ctx, SESSIONS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hook)
            .setColor(ctx.getColor(R.color.accent))
            .setContentTitle("${kind.icon} ${s.title}")
            .setContentText("${s.project.ifEmpty { "session" }} — ${kind.label}")
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(open(ctx, s.id))
            .build()
        manager(ctx).notify(TAG_PREFIX + s.id, SESSION_ID, n)
    }

    fun cancelSession(ctx: Context, id: String) = manager(ctx).cancel(TAG_PREFIX + id, SESSION_ID)

    /** The app is on screen and shows the same thing. */
    fun cancelSessions(ctx: Context) {
        val m = manager(ctx)
        m.activeNotifications.filter { it.tag?.startsWith(TAG_PREFIX) == true }.forEach { m.cancel(it.tag, it.id) }
    }

    private fun open(ctx: Context, session: String?): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (session != null) intent.putExtra(EXTRA_SESSION, session)
        return PendingIntent.getActivity(
            ctx, session?.hashCode() ?: 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun manager(ctx: Context) = ctx.getSystemService(NotificationManager::class.java)
}
