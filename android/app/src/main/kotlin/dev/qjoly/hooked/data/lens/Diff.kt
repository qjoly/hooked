package dev.qjoly.hooked.data.lens

// rune-kit's diff model (diff/model.rs, diff/myers.rs): files of hunks of lines computed from two texts.

enum class Side { OLD, NEW }

/** Declared in rune's order: the ordinal feeds the reviewed fingerprint. */
enum class LineKind { CONTEXT, ADDED, REMOVED }

data class DiffLine(
    val kind: LineKind,
    val old: Int?,
    val new: Int?,
    val text: String,
    /** Char ranges of `text` that differ from the line it pairs with. */
    val changes: List<IntRange> = emptyList(),
    val noNewline: Boolean = false,
) {
    fun number(side: Side) = if (side == Side.OLD) old else new
}

data class Hunk(val oldStart: Int, val oldCount: Int, val newStart: Int, val newCount: Int, val section: String, val lines: List<DiffLine>) {
    fun first(side: Side): Int {
        val (start, count) = if (side == Side.OLD) oldStart to oldCount else newStart to newCount
        return if (count == 0) start + 1 else maxOf(start, 1)
    }

    fun end(side: Side) = first(side) + if (side == Side.OLD) oldCount else newCount

    fun header(): String {
        fun range(start: Int, count: Int) = if (count == 1) "$start" else "$start,$count"
        val h = "@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@"
        return if (section.isEmpty()) h else "$h $section"
    }
}

/** A whole text split into lines, without their breaks. */
class Source(val text: String) {
    val lines: List<String>

    init {
        val out = ArrayList<String>()
        var start = 0
        while (true) {
            val i = text.indexOf('\n', start)
            if (i < 0) break
            out += text.substring(start, if (i > start && text[i - 1] == '\r') i - 1 else i)
            start = i + 1
        }
        if (start < text.length) out += text.substring(start).removeSuffix("\r")
        lines = out
    }

    val size get() = lines.size

    /** Line `n`, 1-based. */
    fun line(n: Int): String? = lines.getOrNull(n - 1)

    val endsWithoutNewline get() = text.isNotEmpty() && !text.endsWith('\n')
}

class FileDiff(val path: String, val hunks: List<Hunk>, val oldText: Source?, val newText: Source?, val binary: Boolean = false) {
    val additions by lazy { hunks.sumOf { h -> h.lines.count { it.kind == LineKind.ADDED } } }
    val deletions by lazy { hunks.sumOf { h -> h.lines.count { it.kind == LineKind.REMOVED } } }

    fun text(side: Side): String? = (if (side == Side.OLD) oldText else newText)?.text

    val expandable get() = oldText != null || newText != null

    /** `NEW` for a file that only has added lines, `OLD` for one only removed. */
    fun soleSide(): Side? {
        val o = oldText?.text?.isEmpty()
        val n = newText?.text?.isEmpty()
        return when {
            o == true && n == false -> Side.NEW
            o == false && n == true -> Side.OLD
            else -> null
        }
    }

    fun contextLine(old: Int, new: Int): String? = oldText?.line(old) ?: newText?.line(new)

    fun oldLen(): Int? {
        oldText?.let { return it.size }
        val t = newText ?: return null
        return maxOf(t.size - additions + deletions, 0)
    }

    fun lastLine(): Int {
        val h = hunks.lastOrNull()?.let { maxOf(it.end(Side.OLD), it.end(Side.NEW)) - 1 } ?: 0
        val t = listOfNotNull(oldText, newText).maxOfOrNull { it.size } ?: 0
        return maxOf(h, t)
    }

    /** Digits the line numbers take, at least three. */
    val digits: Int get() = maxOf(lastLine().coerceAtLeast(1).toString().length, 3)

    companion object {
        const val CONTEXT = 3

        fun fromTexts(path: String, old: String, new: String, context: Int = CONTEXT): FileDiff {
            if (old.contains('\u0000') || new.contains('\u0000')) return FileDiff(path, emptyList(), null, null, binary = true)
            val a = Source(old)
            val b = Source(new)
            return FileDiff(path, pairWords(hunks(a, b, context)), a, b)
        }
    }
}

private fun intern(s: Source, ids: HashMap<Pair<String, Boolean>, Int>): IntArray {
    val last = s.size
    return IntArray(last) { i ->
        val key = s.lines[i] to (i + 1 == last && s.endsWithoutNewline)
        ids.getOrPut(key) { ids.size }
    }
}

private fun hunks(old: Source, new: Source, context: Int): List<Hunk> {
    val ids = HashMap<Pair<String, Boolean>, Int>()
    val a = intern(old, ids)
    val b = intern(new, ids)
    // Changes as (old range, new range), 0-based, end exclusive.
    val changes = ArrayList<IntArray>()
    var i = 0
    var j = 0
    for (op in Myers.diff(a, b)) {
        when (op) {
            is Myers.Op.Equal -> {
                i += op.len
                j += op.len
            }
            is Myers.Op.Delete -> {
                val c = changes.lastOrNull()
                if (c != null && c[1] == i && c[3] == j) c[1] += op.len else changes += intArrayOf(i, i + op.len, j, j)
                i += op.len
            }
            is Myers.Op.Insert -> {
                val c = changes.lastOrNull()
                if (c != null && c[1] == i && c[3] == j) c[3] += op.len else changes += intArrayOf(i, i, j, j + op.len)
                j += op.len
            }
        }
    }
    val groups = ArrayList<MutableList<IntArray>>()
    for (c in changes) {
        val last = groups.lastOrNull()?.lastOrNull()
        if (last != null && c[0] - last[1] <= 2 * context) groups.last() += c else groups += mutableListOf(c)
    }
    fun line(s: Source, n: Int) = s.line(n + 1).orEmpty()
    return groups.map { g ->
        val first = g.first()
        val lastC = g.last()
        val start = maxOf(first[0] - context, 0)
        val shift = first[0] - start
        val os = start
        val ns = first[2] - shift
        val endOld = minOf(lastC[1] + context, old.size)
        val lines = ArrayList<DiffLine>()
        var x = os
        var y = ns
        for (c in g) {
            while (x < c[0]) {
                lines += DiffLine(LineKind.CONTEXT, x + 1, y + 1, line(old, x))
                x++
                y++
            }
            for (n in c[0] until c[1]) lines += DiffLine(LineKind.REMOVED, n + 1, null, line(old, n))
            for (n in c[2] until c[3]) lines += DiffLine(LineKind.ADDED, null, n + 1, line(new, n))
            x = c[1]
            y = c[3]
        }
        while (x < endOld) {
            lines += DiffLine(LineKind.CONTEXT, x + 1, y + 1, line(old, x))
            x++
            y++
        }
        val marked = lines.map { l ->
            val eof = when (l.kind) {
                LineKind.REMOVED, LineKind.CONTEXT -> l.old == old.size && old.endsWithoutNewline
                LineKind.ADDED -> l.new == new.size && new.endsWithoutNewline
            }
            if (eof) l.copy(noNewline = true) else l
        }
        val oc = x - os
        val nc = y - ns
        Hunk(if (oc == 0) os else os + 1, oc, if (nc == 0) ns else ns + 1, nc, section(old, os), marked)
    }
}

/** The nearest line above 0-based `before` that starts at the left margin, as `git diff` names a hunk. */
private fun section(s: Source, before: Int): String {
    var n = minOf(before, s.size)
    var seen = 0
    while (n >= 1 && seen < 2000) {
        val l = s.line(n)
        if (l != null && l.isNotEmpty() && (l[0].isLetter() || l[0] == '_' || l[0] == '$')) return l.trimEnd().take(80)
        n--
        seen++
    }
    return ""
}

/** Word changes for each run of removed lines followed by added ones, paired in order. */
private fun pairWords(hunks: List<Hunk>): List<Hunk> = hunks.map { h ->
    val lines = h.lines.toMutableList()
    var i = 0
    while (i < lines.size) {
        val del = i
        while (i < lines.size && lines[i].kind == LineKind.REMOVED) i++
        val add = i
        while (i < lines.size && lines[i].kind == LineKind.ADDED) i++
        if (add == del || i == add) {
            i = maxOf(i, del + 1)
            continue
        }
        val pairs = minOf(add - del, i - add)
        if (pairs <= 128) {
            for (k in 0 until pairs) {
                val (a, b) = Myers.words(lines[del + k].text, lines[add + k].text)
                lines[del + k] = lines[del + k].copy(changes = a)
                lines[add + k] = lines[add + k].copy(changes = b)
            }
        }
    }
    h.copy(lines = lines)
}

/** Myers' O(ND) diff, linear space, as rune-kit's myers.rs. */
internal object Myers {
    sealed interface Op {
        data class Equal(val old: Int, val new: Int, val len: Int) : Op
        data class Delete(val old: Int, val len: Int) : Op
        data class Insert(val new: Int, val len: Int) : Op
    }

    private const val MAX_D = 1024

    private class Vs(size: Int, val off: Int) {
        val f = IntArray(size)
        val b = IntArray(size)
        fun i(k: Int) = k + off
    }

    fun diff(a: IntArray, b: IntArray): List<Op> {
        val ca = BooleanArray(a.size)
        val cb = BooleanArray(b.size)
        val v = Vs(a.size + b.size + 3, b.size + 1)
        conquer(a, 0, a.size, b, 0, b.size, v, ca, cb)
        return script(ca, cb)
    }

    private fun conquer(a: IntArray, a0: Int, a1: Int, b: IntArray, b0: Int, b1: Int, v: Vs, ca: BooleanArray, cb: BooleanArray) {
        var aS = a0
        var aE = a1
        var bS = b0
        var bE = b1
        while (aS < aE && bS < bE && a[aS] == b[bS]) {
            aS++
            bS++
        }
        while (aS < aE && bS < bE && a[aE - 1] == b[bE - 1]) {
            aE--
            bE--
        }
        when {
            aS == aE -> for (k in bS until bE) cb[k] = true
            bS == bE -> for (k in aS until aE) ca[k] = true
            else -> {
                val m = middleSnake(a, aS, aE, b, bS, bE, v)
                if (m != null) {
                    conquer(a, aS, m.first, b, bS, m.second, v, ca, cb)
                    conquer(a, m.first, aE, b, m.second, bE, v, ca, cb)
                } else {
                    for (k in aS until aE) ca[k] = true
                    for (k in bS until bE) cb[k] = true
                }
            }
        }
    }

    private fun middleSnake(a: IntArray, xoff: Int, xlim: Int, b: IntArray, yoff: Int, ylim: Int, v: Vs): Pair<Int, Int>? {
        val dmin = xoff - ylim
        val dmax = xlim - yoff
        val fmid = xoff - yoff
        val bmid = xlim - ylim
        var fmin = fmid
        var fmax = fmid
        var bmin = bmid
        var bmax = bmid
        val odd = ((fmid - bmid) and 1) != 0
        fun ok(x: Int, y: Int): Pair<Int, Int>? {
            val cx = x.coerceIn(xoff, xlim)
            val cy = y.coerceIn(yoff, ylim)
            return if ((cx == xlim && cy == ylim) || (cx == xoff && cy == yoff)) null else cx to cy
        }
        v.f[v.i(fmid)] = xoff
        v.b[v.i(bmid)] = xlim
        repeat(MAX_D) {
            if (fmin > dmin) {
                fmin--
                v.f[v.i(fmin - 1)] = -1
            } else {
                fmin++
            }
            if (fmax < dmax) {
                fmax++
                v.f[v.i(fmax + 1)] = -1
            } else {
                fmax--
            }
            var d = fmax
            while (d >= fmin) {
                val lo = v.f[v.i(d - 1)]
                val hi = v.f[v.i(d + 1)]
                var x = if (lo >= hi) lo + 1 else hi
                var y = x - d
                while (x < xlim && y < ylim && a[x] == b[y]) {
                    x++
                    y++
                }
                v.f[v.i(d)] = x
                if (odd && bmin <= d && d <= bmax && v.b[v.i(d)] <= x) return ok(x, y)
                d -= 2
            }
            if (bmin > dmin) {
                bmin--
                v.b[v.i(bmin - 1)] = Int.MAX_VALUE
            } else {
                bmin++
            }
            if (bmax < dmax) {
                bmax++
                v.b[v.i(bmax + 1)] = Int.MAX_VALUE
            } else {
                bmax--
            }
            d = bmax
            while (d >= bmin) {
                val lo = v.b[v.i(d - 1)]
                val hi = v.b[v.i(d + 1)]
                var x = if (lo < hi) lo else hi - 1
                var y = x - d
                while (xoff < x && yoff < y && a[x - 1] == b[y - 1]) {
                    x--
                    y--
                }
                v.b[v.i(d)] = x
                if (!odd && fmin <= d && d <= fmax && x <= v.f[v.i(d)]) return ok(x, y)
                d -= 2
            }
        }
        // Too costly: cut at the furthest forward point reached, the last one on a tie.
        var best: Pair<Int, Int>? = null
        var d = fmin
        while (d <= fmax) {
            val x = v.f[v.i(d)]
            if (best == null || 2 * x - d >= 2 * best.first - best.second) best = x to d
            d += 2
        }
        val (x, bd) = best ?: return null
        return ok(x, x - bd)
    }

    private fun script(ca: BooleanArray, cb: BooleanArray): List<Op> {
        val out = ArrayList<Op>()
        var i = 0
        var j = 0
        while (i < ca.size || j < cb.size) {
            val si = i
            val sj = j
            while (i < ca.size && j < cb.size && !ca[i] && !cb[j]) {
                i++
                j++
            }
            if (i > si) out += Op.Equal(si, sj, i - si)
            val di = i
            while (i < ca.size && ca[i]) i++
            if (i > di) out += Op.Delete(di, i - di)
            val dj = j
            while (j < cb.size && cb[j]) j++
            if (j > dj) out += Op.Insert(dj, j - dj)
            if (i == si && j == sj) break
        }
        return out
    }

    /** The changed char ranges of two paired lines, or nothing when they share too little to say. */
    fun words(old: String, new: String): Pair<List<IntRange>, List<IntRange>> {
        if (old == new || old.length > 1000 || new.length > 1000) return emptyList<IntRange>() to emptyList()
        val ta = tokens(old)
        val tb = tokens(new)
        val ids = HashMap<String, Int>()
        val sa = ta.map { old.substring(it.first, it.last + 1) }
        val sb = tb.map { new.substring(it.first, it.last + 1) }
        val ia = IntArray(sa.size) { ids.getOrPut(sa[it]) { ids.size } }
        val ib = IntArray(sb.size) { ids.getOrPut(sb[it]) { ids.size } }
        var shared = 0
        val ra = ArrayList<IntRange>()
        val rb = ArrayList<IntRange>()
        for (op in diff(ia, ib)) {
            when (op) {
                is Op.Equal -> shared += (op.old until op.old + op.len).sumOf { if (sa[it].isBlank()) 0 else sa[it].length }
                is Op.Delete -> ra += ta[op.old].first..ta[op.old + op.len - 1].last
                is Op.Insert -> rb += tb[op.new].first..tb[op.new + op.len - 1].last
            }
        }
        fun content(s: String) = maxOf(s.count { !it.isWhitespace() }, 1)
        if (shared * 4 < maxOf(content(old), content(new))) return emptyList<IntRange>() to emptyList()
        return join(old, ra) to join(new, rb)
    }

    private fun join(text: String, ranges: List<IntRange>): List<IntRange> {
        val out = ArrayList<IntRange>()
        for (r in ranges) {
            val last = out.lastOrNull()
            if (last != null && text.substring(last.last + 1, r.first).all { it.isWhitespace() }) out[out.size - 1] = last.first..r.last
            else out += r
        }
        return out
    }

    private fun tokens(s: String): List<IntRange> {
        fun kind(c: Char) = when {
            c.isLetterOrDigit() || c == '_' -> 0
            c.isWhitespace() -> 1
            else -> 2
        }
        val out = ArrayList<IntRange>()
        var prev = -1
        for ((i, c) in s.withIndex()) {
            val k = kind(c)
            if (out.isNotEmpty() && prev == k && k != 2) out[out.size - 1] = out.last().first..i else out += i..i
            prev = k
        }
        return out
    }
}
