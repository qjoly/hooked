package dev.qjoly.hooked.ui.terminal

import com.termux.terminal.WcWidth
import kotlin.math.floor

// Pure reads of one terminal row, ported from rune's ghostty.rs line helpers (links, matches,
// columns) and terminal.rs selection, on top of Termux's char arrays.

/**
 * One row cut into cells: the column each starts at, how many columns it covers and the chars that
 * draw it, combining marks included. Reused across rows so painting allocates nothing per frame.
 */
class Cells(capacity: Int = 160) {
    var count = 0
        private set
    var col = IntArray(capacity)
        private set
    var width = IntArray(capacity)
        private set
    var start = IntArray(capacity)
        private set
    var end = IntArray(capacity)
        private set
    var point = IntArray(capacity)
        private set

    private fun add(c: Int, w: Int, s: Int, e: Int, cp: Int) {
        if (count == col.size) {
            val n = col.size * 2
            col = col.copyOf(n); width = width.copyOf(n); start = start.copyOf(n); end = end.copyOf(n); point = point.copyOf(n)
        }
        col[count] = c; width[count] = w; start[count] = s; end[count] = e; point[count] = cp
        count++
    }

    /** Termux's renderer walk: a wide glyph is one char over two columns, marks ride on the code point before them. */
    fun scan(text: CharArray, used: Int, columns: Int): Cells {
        count = 0
        var column = 0
        var i = 0
        val n = minOf(used, text.size)
        while (column < columns && i < n) {
            val c = text[i]
            val pair = Character.isHighSurrogate(c) && i + 1 < n
            val cp = if (pair) Character.toCodePoint(c, text[i + 1]) else c.code
            val w = WcWidth.width(cp).coerceAtLeast(0)
            val s = i
            i += if (pair) 2 else 1
            while (i < n && WcWidth.width(text, i) <= 0) i += if (Character.isHighSurrogate(text[i]) && i + 1 < n) 2 else 1
            add(column, w, s, i, cp)
            column += w
        }
        return this
    }

    /** The cell covering column `c`, or -1 past the row's end. */
    fun at(c: Int): Int {
        for (k in 0 until count) if (c >= col[k] && c < col[k] + maxOf(width[k], 1)) return k
        return -1
    }
}

/** A row as a string, with where each cell's chars start in it, for searching and link detection. */
class RowText(val text: String, private val cellAt: IntArray, private val cols: IntArray, private val widths: IntArray) {
    /** Columns `[a, b)` covered by string indices `[from, to)`. */
    fun colRange(from: Int, to: Int): Pair<Int, Int> {
        val a = cellOf(from)
        val b = cellOf((to - 1).coerceAtLeast(from))
        if (a < 0) return 0 to 0
        return cols[a] to cols[b] + maxOf(widths[b], 1)
    }

    private fun cellOf(index: Int): Int {
        var k = -1
        for (i in cellAt.indices) if (cellAt[i] <= index) k = i else break
        return k
    }

    /** The cell text at column `c`, empty past the end. */
    fun charAtCol(c: Int): String {
        for (i in cols.indices) {
            if (c >= cols[i] && c < cols[i] + maxOf(widths[i], 1)) {
                val e = if (i + 1 < cellAt.size) cellAt[i + 1] else text.length
                return text.substring(cellAt[i], e)
            }
        }
        return ""
    }

    companion object {
        fun of(text: CharArray, cells: Cells): RowText {
            val sb = StringBuilder()
            val at = IntArray(cells.count)
            for (k in 0 until cells.count) {
                at[k] = sb.length
                sb.appendRange(text, cells.start[k], cells.end[k])
            }
            return RowText(sb.toString(), at, cells.col.copyOf(cells.count), cells.width.copyOf(cells.count))
        }

        /** A plain ASCII row, one column per char: tests and simple callers. */
        fun plain(s: String) = RowText(s, IntArray(s.length) { it }, IntArray(s.length) { it }, IntArray(s.length) { 1 })
    }
}

/** A detected URL over columns `[a, b)`. */
data class Link(val a: Int, val b: Int, val url: String)

/** Plain `http(s)://` URLs on a row, trailing punctuation dropped unless it closes a parenthesis (rune's `links`). */
fun links(row: RowText): List<Link> {
    val t = row.text
    val out = mutableListOf<Link>()
    var from = 0
    while (true) {
        val i = listOf("https://", "http://").map { t.indexOf(it, from) }.filter { it >= 0 }.minOrNull() ?: break
        val rest = t.substring(i)
        var end = rest.indexOfFirst { it.isWhitespace() || it in "\"'<>`|" }.let { if (it < 0) rest.length else it }
        while (end > 0 && rest[end - 1] in ".,;:)]}!?") {
            if (rest[end - 1] == ')' && rest.substring(0, end).contains('(')) break
            end--
        }
        if (end > "http://".length) {
            val (a, b) = row.colRange(i, i + end)
            out += Link(a, b, rest.substring(0, end))
        }
        from = i + maxOf(end, 1)
    }
    return out
}

/** Occurrences of `needle` on a row ignoring case, as column ranges `[a, b)` (rune's `matches`). */
fun matches(row: RowText, needle: String): List<Pair<Int, Int>> {
    if (needle.isEmpty()) return emptyList()
    val hay = row.text.lowercase()
    if (hay.length != row.text.length) return emptyList()
    val n = needle.lowercase()
    val out = mutableListOf<Pair<Int, Int>>()
    var i = hay.indexOf(n)
    while (i >= 0) {
        out += row.colRange(i, i + n.length)
        i = hay.indexOf(n, i + n.length)
    }
    return out
}

/** A screen cell: `row` counts from the top of the screen, negative into the scrollback. */
data class CellPos(val col: Int, val row: Int)

/** A selection from where the drag started to where it is, in screen cells. */
data class Sel(val anchor: CellPos, val head: CellPos) {
    fun ordered(): Pair<CellPos, CellPos> =
        if (anchor.row < head.row || (anchor.row == head.row && anchor.col <= head.col)) anchor to head else head to anchor

    /** The columns `[a, b)` of `row` the selection covers. */
    fun rowRange(row: Int, cols: Int): Pair<Int, Int>? {
        val (s, e) = ordered()
        if (row < s.row || row > e.row) return null
        val a = if (row == s.row) s.col else 0
        val b = if (row == e.row) e.col + 1 else cols
        return if (b > a) a to b else null
    }

    /** The same text after the screen scrolled `n` rows up. */
    fun shifted(n: Int) = Sel(anchor.copy(row = anchor.row - n), head.copy(row = head.row - n))

    val empty get() = anchor == head
}

/** The word around column `col`: rune's double-click rule (no blanks, quotes, brackets or separators). */
fun wordAt(row: RowText, col: Int, cols: Int): Pair<Int, Int>? {
    fun word(c: Int): Boolean {
        val s = row.charAtCol(c)
        val ch = s.firstOrNull() ?: return false
        return !ch.isWhitespace() && ch !in "\"'`()[]{}<>|;,"
    }
    if (!word(col)) return null
    var a = col
    var b = col
    while (a > 0 && word(a - 1)) a--
    while (b + 1 < cols && word(b + 1)) b++
    return a to b
}

/** The grid that fits a screen of `w` × `h` pixels, as rune's `fit_terms` clamps it. */
fun fitGrid(w: Float, h: Float, cellW: Float, cellH: Float, pad: Float): Pair<Int, Int> {
    val cols = floor((w - 2 * pad) / cellW).toInt().coerceIn(20, 500)
    val rows = floor((h - 2 * pad) / cellH).toInt().coerceIn(3, 300)
    return cols to rows
}

/** `(rows above the viewport, viewport rows, total rows)` when there is scrollback, as rune's scrollbar reads it. */
data class ScrollPos(val offset: Int, val len: Int, val total: Int) {
    val below get() = (total - offset - len).coerceAtLeast(0)
}

fun scrollPos(transcript: Int, rows: Int, top: Int): ScrollPos? =
    if (transcript > 0) ScrollPos(transcript + top, rows, transcript + rows) else null
