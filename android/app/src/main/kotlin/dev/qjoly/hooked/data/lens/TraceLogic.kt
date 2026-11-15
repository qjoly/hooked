package dev.qjoly.hooked.data.lens

import java.util.Locale

// The Trace lens's arithmetic (view/lenses.rs): durations, the span bars and clipped bodies.

fun dur(ms: Double): String = when {
    ms < 1000.0 -> "${Math.round(ms)}ms"
    ms < 60_000.0 -> String.format(Locale.ROOT, "%.1fs", ms / 1000.0)
    else -> "${(ms / 60_000.0).toLong()}m${((ms % 60_000.0) / 1000.0).toLong()}s"
}

/** A span's bar inside its turn: offset and length as fractions, never thinner than a sliver. */
fun spanBar(start: Double, end: Double, t0: Double, total: Double): Pair<Float, Float> {
    val off = ((start - t0) / total).coerceIn(0.0, 1.0).toFloat()
    val len = maxOf(((end - start) / total).toFloat(), 0.004f).coerceAtMost(maxOf(1f - off, 0f))
    return off to len
}

/** The first `maxLines` lines, and how many more there were. */
fun clip(s: String, maxLines: Int): String {
    val lines = rustLines(s)
    if (lines.size <= maxLines) return s
    return lines.take(maxLines).joinToString("\n") + "\n… ${lines.size - maxLines} more lines"
}

/** A turn's span count. */
fun traceCalls(turns: List<TraceTurn>) = turns.sumOf { it.spans.size }
