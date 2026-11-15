package dev.qjoly.hooked.state

// rune-kit's `FileDiff::from_texts_with_context`: a line diff cut into hunks with context around the changes.

enum class LineKind { CONTEXT, ADDED, REMOVED }

data class DiffLine(val kind: LineKind, val text: String)

data class Hunk(val lines: List<DiffLine>)

private fun splitLines(s: String): List<String> = if (s.isEmpty()) emptyList() else s.removeSuffix("\n").split('\n')

/** Past this many LCS cells the diff falls back to "all removed, all added". */
private const val MAX_CELLS = 4_000_000L

fun diffLines(old: String, new: String): List<DiffLine> {
    val a = splitLines(old)
    val b = splitLines(new)
    var pre = 0
    while (pre < a.size && pre < b.size && a[pre] == b[pre]) pre++
    var suf = 0
    while (suf < a.size - pre && suf < b.size - pre && a[a.size - 1 - suf] == b[b.size - 1 - suf]) suf++
    val out = ArrayList<DiffLine>(a.size + b.size)
    for (i in 0 until pre) out += DiffLine(LineKind.CONTEXT, a[i])
    val am = a.subList(pre, a.size - suf)
    val bm = b.subList(pre, b.size - suf)
    if (am.size.toLong() * bm.size > MAX_CELLS) {
        am.forEach { out += DiffLine(LineKind.REMOVED, it) }
        bm.forEach { out += DiffLine(LineKind.ADDED, it) }
    } else {
        val n = am.size
        val m = bm.size
        // lcs[i][j]: common length of am[i..] and bm[j..].
        val lcs = Array(n + 1) { IntArray(m + 1) }
        for (i in n - 1 downTo 0) for (j in m - 1 downTo 0) {
            lcs[i][j] = if (am[i] == bm[j]) lcs[i + 1][j + 1] + 1 else maxOf(lcs[i + 1][j], lcs[i][j + 1])
        }
        var i = 0
        var j = 0
        // Removals come before additions within a change, as git prints them.
        while (i < n && j < m) {
            when {
                am[i] == bm[j] -> { out += DiffLine(LineKind.CONTEXT, am[i]); i++; j++ }
                lcs[i + 1][j] >= lcs[i][j + 1] -> { out += DiffLine(LineKind.REMOVED, am[i]); i++ }
                else -> { out += DiffLine(LineKind.ADDED, bm[j]); j++ }
            }
        }
        while (i < n) out += DiffLine(LineKind.REMOVED, am[i++])
        while (j < m) out += DiffLine(LineKind.ADDED, bm[j++])
    }
    for (i in a.size - suf until a.size) out += DiffLine(LineKind.CONTEXT, a[i])
    return out
}

/** Changed lines with up to `context` unchanged ones around them; hunks closer than that merge. */
fun diffHunks(old: String, new: String, context: Int = 3): List<Hunk> {
    val lines = diffLines(old, new)
    val changed = lines.indices.filter { lines[it].kind != LineKind.CONTEXT }
    if (changed.isEmpty()) return emptyList()
    val hunks = mutableListOf<Hunk>()
    var start = maxOf(0, changed.first() - context)
    var end = minOf(lines.size - 1, changed.first() + context)
    for (c in changed.drop(1)) {
        if (c - context <= end + 1) {
            end = minOf(lines.size - 1, c + context)
        } else {
            hunks += Hunk(lines.subList(start, end + 1).toList())
            start = maxOf(0, c - context)
            end = minOf(lines.size - 1, c + context)
        }
    }
    hunks += Hunk(lines.subList(start, end + 1).toList())
    return hunks
}
