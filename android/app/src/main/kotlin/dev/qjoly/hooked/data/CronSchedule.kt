package dev.qjoly.hooked.data

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

// The web's src/lib/cron.js (via desktop-rune's cron.rs), so the preview agrees with the server's scheduler:
// five fields in local time, Vixie day-of-month / day-of-week OR rule.

class CronException(message: String) : Exception(message)

private class CronField(val name: String, val min: Int, val max: Int)

private val FIELDS = listOf(
    CronField("minute", 0, 59),
    CronField("hour", 0, 23),
    CronField("day of month", 1, 31),
    CronField("month", 1, 12),
    CronField("day of week", 0, 7),
)

private val ALIASES = mapOf(
    "@hourly" to "0 * * * *",
    "@daily" to "0 0 * * *",
    "@midnight" to "0 0 * * *",
    "@weekly" to "0 0 * * 0",
    "@monthly" to "0 0 1 * *",
    "@yearly" to "0 0 1 1 *",
    "@annually" to "0 0 1 1 *",
)

private val PART = Regex("""^(?:\*|(\d+)(?:-(\d+))?)(?:/(\d+))?$""")
private const val DAY = 86_400_000L

private fun parseField(src: String, f: CronField): Set<Int> {
    val out = sortedSetOf<Int>()
    for (part in src.split(',')) {
        val m = PART.matchEntire(part) ?: throw CronException("invalid ${f.name}: \"$part\"")
        val (a, b, s) = m.destructured
        val n = { x: String -> x.toLongOrNull() ?: Long.MAX_VALUE }
        var lo = f.min.toLong()
        var hi = f.max.toLong()
        // `5/15` means "from 5, every 15", as in Vixie cron.
        if (a.isNotEmpty()) {
            lo = n(a)
            hi = if (b.isNotEmpty()) n(b) else if (s.isNotEmpty()) f.max.toLong() else lo
        }
        val step = if (s.isNotEmpty()) n(s) else 1L
        if (lo < f.min || hi > f.max || lo > hi || step < 1) throw CronException("${f.name} out of range: \"$part\"")
        var v = lo
        while (v <= hi) {
            out += v.toInt()
            v += step
        }
    }
    return out
}

class CronSchedule private constructor(
    val minute: Set<Int>,
    val hour: Set<Int>,
    val dom: Set<Int>,
    val month: Set<Int>,
    val dow: Set<Int>,
    private val domAny: Boolean,
    private val dowAny: Boolean,
) {
    private fun dayMatches(d: ZonedDateTime): Boolean {
        val inDom = d.dayOfMonth in dom
        val inDow = d.dayOfWeek.value % 7 in dow
        return if (domAny || dowAny) inDom && inDow else inDom || inDow
    }

    /** First matching minute strictly after `fromMs`, or null (e.g. "0 0 30 2 *" never fires). */
    fun next(fromMs: Long, zone: ZoneId = ZoneId.systemDefault()): Long? {
        var d = Instant.ofEpochMilli(fromMs).atZone(zone).truncatedTo(ChronoUnit.MINUTES).plusMinutes(1)
        val limit = d.toInstant().toEpochMilli() + 5 * 366 * DAY
        while (d.toInstant().toEpochMilli() < limit) {
            d = when {
                d.monthValue !in month -> d.withDayOfMonth(1).plusMonths(1).truncatedTo(ChronoUnit.DAYS)
                !dayMatches(d) -> d.plusDays(1).truncatedTo(ChronoUnit.DAYS)
                d.hour !in hour -> d.plusHours(1).truncatedTo(ChronoUnit.HOURS)
                d.minute !in minute -> d.plusMinutes(1)
                else -> return d.toInstant().toEpochMilli()
            }
        }
        return null
    }

    companion object {
        /** Throws [CronException] with a readable message on an invalid expression. */
        fun parse(expr: String): CronSchedule {
            val src = expr.trim().lowercase()
            val parts = (ALIASES[src] ?: src).split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (parts.size != 5) throw CronException("expected 5 fields: minute hour day-of-month month day-of-week")
            val f = parts.mapIndexed { i, p -> parseField(p, FIELDS[i]) }
            val dow = f[4].toSortedSet()
            if (dow.remove(7)) dow += 0
            return CronSchedule(f[0], f[1], f[2], f[3], dow, parts[2] == "*", parts[4] == "*")
        }
    }
}

fun validCron(expr: String): String? = try {
    CronSchedule.parse(expr)
    null
} catch (e: CronException) {
    e.message
}

fun nextRuns(expr: String, count: Int = 3, fromMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): List<Long> {
    val c = CronSchedule.parse(expr)
    val out = mutableListOf<Long>()
    var t = fromMs
    while (out.size < count) {
        val n = c.next(t, zone) ?: break
        out += n
        t = n
    }
    return out
}

/** "Tue 10 Nov 17:00", in local time. */
fun cronStamp(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    val t = Instant.ofEpochMilli(ms).atZone(zone)
    val day = t.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)
    val month = t.month.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)
    return "$day ${t.dayOfMonth} $month ${String.format(Locale.ROOT, "%02d:%02d", t.hour, t.minute)}"
}

enum class PreviewTone { FAINT, WARNING, DANGER }

/** The form's preview line: the next three runs, "Never runs", or the parse error. */
fun cronPreview(expr: String, now: Long, zone: ZoneId = ZoneId.systemDefault()): Pair<String, PreviewTone> = try {
    val runs = nextRuns(expr, 3, now, zone)
    if (runs.isEmpty()) "Never runs" to PreviewTone.WARNING
    else "Next: " + runs.joinToString(" · ") { cronStamp(it, zone) } to PreviewTone.FAINT
} catch (e: CronException) {
    (e.message ?: "invalid schedule") to PreviewTone.DANGER
}
