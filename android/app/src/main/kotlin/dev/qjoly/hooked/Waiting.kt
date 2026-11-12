package dev.qjoly.hooked

/** What the background watcher needs from one entry of /api/sessions, plus its session-meta. */
data class SessionInfo(
    val id: String,
    val title: String,
    val project: String,
    val state: String,
    val hasQuestion: Boolean,
    val snoozedUntil: Long = 0,
)

/** Mirrors NOTIFY_KINDS in src/lib/notify.js. */
enum class Kind(val icon: String, val label: String, val waitsOnYou: Boolean) {
    QUESTION("⌨️", "awaiting your reply", true),
    ATTENTION("🔴", "action required", true),
    WAITING("🟡", "finished — waiting for you", true),
    ENDED("🏁", "session ended", false),
}

/** Mirrors notifyKeyFor in src/lib/notify.js: working, idle and background never notify. */
fun kindOf(s: SessionInfo): Kind? = when {
    s.hasQuestion -> Kind.QUESTION
    s.state == "attention" -> Kind.ATTENTION
    s.state == "waiting" -> Kind.WAITING
    s.state == "ended" -> Kind.ENDED
    else -> null
}

/** Follows the list from pass to pass, like the dashboard's checkNotifications. */
class Tracker {
    private var previous: Map<String, Kind?>? = null

    class Pass(
        /** Sessions that just became notifiable, or changed kind. */
        val fresh: List<Pair<SessionInfo, Kind>>,
        /** Sessions that stopped being notifiable, or left the list. */
        val cleared: List<String>,
        /** What waits on you right now, snoozed sessions left out (the dashboard's badge). */
        val waiting: List<Pair<SessionInfo, Kind>>,
    )

    fun update(sessions: List<SessionInfo>, now: Long): Pass {
        val next = sessions.associate { it.id to kindOf(it) }
        val before = previous
        previous = next
        // The first pass only records, so opening the app does not replay everything at once.
        val fresh = if (before == null) emptyList() else sessions.mapNotNull { s ->
            next[s.id]?.takeIf { it != before[s.id] }?.let { s to it }
        }
        val cleared = before.orEmpty().filter { (id, k) -> k != null && next[id] == null }.keys.toList()
        val waiting = sessions.mapNotNull { s ->
            next[s.id]?.takeIf { it.waitsOnYou && s.snoozedUntil <= now }?.let { s to it }
        }
        return Pass(fresh, cleared, waiting)
    }
}
