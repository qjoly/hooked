package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.Meta
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.SessionState
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

// desktop's sections.rs, organize.rs, fleet.rs and fmt.rs, kept pure so they test without Android.

const val DAY_MS = 86_400_000L

private val EMPTY_META = Meta()

fun Map<String, Meta>.of(id: String) = this[id] ?: EMPTY_META

/** Ended or past, and quiet for a day: archived even without the flag. */
fun isCold(s: Session, now: Long): Boolean {
    if (s.state != SessionState.ENDED && s.state != SessionState.PAST) return false
    val seen = s.lastSeenTs ?: s.lastActivity ?: return true
    return now - seen > DAY_MS
}

fun isArchived(s: Session, meta: Map<String, Meta>, now: Long) = meta.of(s.id).archived || isCold(s, now)

fun isSnoozed(s: Session, meta: Map<String, Meta>, now: Long) = (meta.of(s.id).snoozeUntil ?: 0) > now

/** In incognito mode only the sessions flagged incognito show. */
fun isVisible(s: Session, meta: Map<String, Meta>, incognito: Boolean) = !incognito || meta.of(s.id).incognito

/** A sidebar entry: a session and the members of its group. */
data class GroupUnit(val lead: Session, val children: List<Session>) {
    val all get() = listOf(lead) + children
}

/** Children follow their mother when she is in the same list; an orphan stands alone. */
fun units(list: List<Session>, meta: Map<String, Meta>): List<GroupUnit> {
    val ids = list.map { it.id }.toHashSet()
    val kids = LinkedHashMap<String, MutableList<Session>>()
    for (s in list) {
        val m = meta.of(s.id).groupOf
        if (m != null && m != s.id && m in ids) kids.getOrPut(m) { mutableListOf() } += s
    }
    return list.filter { s -> meta.of(s.id).groupOf.let { it == null || it == s.id || it !in ids } }
        .map { GroupUnit(it, kids[it.id].orEmpty()) }
}

enum class Section(val label: String) { WAITING("Waiting"), WORKING("Working"), IDLE("Idle"), SNOOZED("Snoozed"), ARCHIVED("Archived") }

fun sectionOf(u: GroupUnit, meta: Map<String, Meta>, now: Long): Section {
    if (u.all.all { isArchived(it, meta, now) }) return Section.ARCHIVED
    val awake = u.all.filter { !isArchived(it, meta, now) && !isSnoozed(it, meta, now) }
    // A group with any member still at work is working: a mother waiting on her children's
    // results isn't waiting on you yet.
    return when {
        awake.isEmpty() -> Section.SNOOZED
        awake.any { it.state == SessionState.WORKING || it.state == SessionState.BACKGROUND } -> Section.WORKING
        awake.any { it.needsYou } -> Section.WAITING
        else -> Section.IDLE
    }
}

/** The member whose state a folded group wears, with [sectionOf]'s precedence: a member at work
 *  before a pending decision. Ties go to the earliest member, so the lead by default. */
fun groupFace(u: GroupUnit): Session = u.all.minBy {
    when {
        it.state == SessionState.WORKING -> 0
        it.state == SessionState.BACKGROUND -> 1
        it.needsYou -> 2
        it.state == SessionState.ENDED || it.state == SessionState.PAST -> 4
        else -> 3
    }
}

/** The title a row shows: a local rename first, then the server's title chain. */
fun titleOf(s: Session, names: Map<String, String>) = names[s.id]?.takeIf { it.isNotBlank() } ?: s.title ?: s.lastPrompt ?: s.projectName ?: "(untitled)"

fun projectLabel(s: Session) = s.repo ?: s.projectName ?: "?"

/** A group lead's label: its group name, else its title. */
fun groupLabel(lead: Session, meta: Map<String, Meta>, names: Map<String, String>) =
    meta.of(lead.id).groupName?.takeIf { it.isNotBlank() } ?: titleOf(lead, names)

/** Pinned first, then by mode: dynamic (awaiting you, then recent), alpha, or alpha-project (recent). */
fun sortSessions(list: List<Session>, mode: String, pinned: Set<String>, names: Map<String, String>): List<Session> = when (mode) {
    "alpha" -> list.sortedWith(compareBy<Session>({ it.id !in pinned }, { titleOf(it, names).lowercase() }))
    "alpha-project" -> list.sortedWith(compareBy<Session>({ it.id !in pinned }, { -(it.lastActivity ?: Long.MIN_VALUE / 2) }))
    else -> list.sortedWith(compareBy<Session>({ it.id !in pinned }, { !it.needsYou }, { -(it.lastActivity ?: Long.MIN_VALUE / 2) }))
}

/** The 24h filter keeps what needs you, works, is open, or moved in the last day. */
fun recentEnough(s: Session, now: Long, selected: String?) =
    s.needsYou || s.state == SessionState.WORKING || s.id == selected || (s.lastActivity ?: now) > now - DAY_MS

/** Family index on the fleet wheel: attention, waiting, working, background, idle ("Paused"), ended. */
fun familyOf(s: Session) = when {
    s.hasQuestion || s.hasPlan || s.state == SessionState.ATTENTION -> 0
    s.state == SessionState.WORKING -> 2
    s.state == SessionState.BACKGROUND -> 3
    s.state == SessionState.WAITING -> 1
    s.state == SessionState.ENDED -> 5
    else -> 4
}

val FAMILY_LABELS = listOf("Action required", "Waiting for you", "Working", "Background", "Paused", "Ended")

fun stateLabel(s: Session) = when (s.state) {
    SessionState.WORKING -> "Claude is working"
    SessionState.WAITING -> "Waiting for you"
    SessionState.ATTENTION -> "Action required"
    SessionState.BACKGROUND -> "Running in background"
    SessionState.ENDED -> "Ended"
    SessionState.PAST -> "Past"
    SessionState.IDLE -> "Paused"
    else -> "Unknown"
}

fun isLive(s: Session) = s.state == SessionState.WORKING || s.state == SessionState.BACKGROUND || s.state == SessionState.WAITING || s.state == SessionState.ATTENTION

/** One wheel slice per session, clockwise from 12 o'clock by family then most recent. */
data class Slice(val session: Session, val family: Int, val start: Float, val end: Float, val pulled: Boolean, val quiet: Boolean)

fun wheelSlices(sessions: List<Session>, meta: Map<String, Meta>, now: Long): List<Slice> {
    val sorted = sessions.sortedWith(compareBy<Session>({ familyOf(it) }, { -(it.lastActivity ?: 0) }))
    val n = sorted.size
    return sorted.mapIndexed { i, s ->
        val f = familyOf(s)
        val quiet = isSnoozed(s, meta, now)
        Slice(s, f, i.toFloat() / n, (i + 1).toFloat() / n, f <= 1 && !quiet, quiet)
    }
}

/** Arc gap in per-mille of the circumference. */
fun wheelGap(n: Int) = if (n > 1) minOf(250f / n, 7f) / 1000f else 0f

// Formatting (fmt.rs).

fun span(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}min"
        s < 86_400 -> "${s / 3600}h"
        else -> "${s / 86_400}d"
    }
}

fun agoShort(ts: Long?, now: Long): String = when {
    ts == null -> "—"
    now - ts < 10_000 -> "now"
    else -> span(now - ts)
}

fun clockLabel(at: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    val t = Instant.ofEpochMilli(at).atZone(zone)
    return "${t.hour}:${t.minute.toString().padStart(2, '0')}"
}

/** "9:00", "tmrw 9:00", "Mon 9:00" or "25/11". */
fun wakeLabel(until: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    val day = Instant.ofEpochMilli(until).atZone(zone)
    val days = ChronoUnit.DAYS.between(Instant.ofEpochMilli(now).atZone(zone).toLocalDate(), day.toLocalDate())
    return when {
        days <= 0 -> clockLabel(until, zone)
        days == 1L -> "tmrw ${clockLabel(until, zone)}"
        days < 7 -> "${day.dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH)} ${clockLabel(until, zone)}"
        else -> "${day.dayOfMonth}/${day.monthValue}"
    }
}

/** The snooze presets: label and wake time. "This evening" only when more than 3 h away, "Monday" not when it is tomorrow. */
fun snoozePresets(now: Long, zone: ZoneId = ZoneId.systemDefault()): List<Pair<String, Long>> {
    val t = Instant.ofEpochMilli(now).atZone(zone)
    val out = mutableListOf("1 hour" to now + 3_600_000L, "3 hours" to now + 3 * 3_600_000L)
    val evening = t.toLocalDate().atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
    if (evening - now > 3 * 3_600_000L) out += "This evening" to evening
    out += "Tomorrow" to t.toLocalDate().plusDays(1).atTime(9, 0).atZone(zone).toInstant().toEpochMilli()
    val toMonday = ((8 - t.dayOfWeek.value) % 7).let { if (it == 0) 7 else it }
    if (toMonday != 1) out += "Monday" to t.toLocalDate().plusDays(toMonday.toLong()).atTime(9, 0).atZone(zone).toInstant().toEpochMilli()
    return out
}

/** The cache countdown a row shows instead of, or before, its age. */
fun cacheLeft(s: Session, now: Long): Long? = s.cache?.remainingMs(now)?.takeIf { it > 0 }

private val LINK = Regex("""\[([^\]]*)]\([^)]*\)""")
private val RULE = Regex("""^[|\-: ]+$""")

/** rune's `plain`: markdown flattened to one line, cut to `max` with an ellipsis. */
fun plain(s: String, max: Int): String {
    val joined = s.replace(LINK, "$1").lines()
        .map { it.trim().trimStart('#', '>').trim() }
        .filter { it.isNotEmpty() && !RULE.matches(it) }
        .joinToString(" ")
        .replace("**", "").replace("`", "")
        .replace(" | ", " · ").replace("|", "")
    return if (joined.length > max) joined.take(max) + "…" else joined
}

fun costLabel(cost: Double?): String = when {
    cost == null -> "$0.00"
    cost >= 100 -> "$" + cost.toLong()
    else -> "$" + String.format(java.util.Locale.ROOT, "%.2f", cost)
}

/** Tags typed by hand: commas or spaces, no leading '#', lowercase, unique, in order. */
fun parseTags(text: String) = text.split(',', ' ', '\n', '\t').map { it.trim().trimStart('#').lowercase() }.filter { it.isNotEmpty() }.distinct()
