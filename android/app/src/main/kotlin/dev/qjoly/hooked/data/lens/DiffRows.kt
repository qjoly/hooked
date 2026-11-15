package dev.qjoly.hooked.data.lens

// rune-kit's diff/state.rs row model: files, hunks, folded gaps and the lines expanded out of them.

enum class DiffMode { UNIFIED, SPLIT }

enum class Expand { UP, DOWN, ALL }

data class LineRef(val side: Side, val line: Int)

/** Selected lines of one file, from where the selection started to where it ends. */
data class LineRange(val file: Int, val start: LineRef, val end: LineRef) {
    companion object {
        fun line(file: Int, at: LineRef) = LineRange(file, at, at)
    }
}

/** A widget shown under a line: a review thread, the draft comment, the definition card. */
data class Annotation(val file: Int, val at: LineRef, val id: String)

/** The unchanged range before hunk `i` (or after the last), from these line numbers. */
data class Gap(val old: Int, val new: Int, val len: Int?)

/** Lines one expand step reveals. */
const val EXPAND_STEP = 20

sealed interface DiffRow {
    val file: Int

    data class File(override val file: Int) : DiffRow
    data class Note(override val file: Int) : DiffRow
    data class Fold(override val file: Int, val gap: Int) : DiffRow
    data class Ctx(override val file: Int, val old: Int, val new: Int) : DiffRow
    data class Line(override val file: Int, val hunk: Int, val index: Int) : DiffRow
    data class Pair(override val file: Int, val hunk: Int, val del: Int, val add: Int) : DiffRow
}

fun gaps(f: FileDiff): List<Gap> {
    val out = ArrayList<Gap>(f.hunks.size + 1)
    var old = 1
    var new = 1
    for (h in f.hunks) {
        out += Gap(old, new, maxOf(h.first(Side.OLD) - old, 0))
        old = h.end(Side.OLD)
        new = h.end(Side.NEW)
    }
    val len = f.oldLen()?.let { maxOf(it + 1 - old, 0) }
    out += Gap(old, new, if (f.hunks.isEmpty()) 0 else len)
    return out
}

/** Lines revealed at the top and bottom of each gap, per file. */
typealias Revealed = List<List<kotlin.Pair<Int, Int>>>

fun emptyRevealed(files: List<FileDiff>): Revealed = files.map { f -> List(f.hunks.size + 1) { 0 to 0 } }

class DiffLayout(val files: List<FileDiff>, val mode: DiffMode, val collapsed: Set<Int>, val revealed: Revealed) {
    val gaps: List<List<Gap>> = files.map(::gaps)
    val rows: List<DiffRow>
    val fileRows: IntArray

    /** Where each hunk starts: its fold row when it has one, else its first line. */
    val hunkRows: IntArray
    private val rowOf = HashMap<Triple<Int, Side, Int>, Int>()

    init {
        val out = ArrayList<DiffRow>()
        val starts = IntArray(files.size)
        val hunkStarts = ArrayList<Int>()
        for ((f, file) in files.withIndex()) {
            starts[f] = out.size
            out += DiffRow.File(f)
            if (f in collapsed) continue
            if (file.hunks.isEmpty()) {
                out += DiffRow.Note(f)
                continue
            }
            for (gap in 0..file.hunks.size) {
                val g = gaps[f][gap]
                val (top, bottom) = revealed.getOrNull(f)?.getOrNull(gap) ?: (0 to 0)
                for (k in 0 until top) out += DiffRow.Ctx(f, g.old + k, g.new + k)
                val firstRow = out.size
                val hidden = g.len?.let { maxOf(it - top - bottom, 0) }
                if (hidden != null && hidden > 0) out += DiffRow.Fold(f, gap)
                g.len?.let { n -> for (k in n - minOf(bottom, n) until n) out += DiffRow.Ctx(f, g.old + k, g.new + k) }
                val h = file.hunks.getOrNull(gap) ?: break
                hunkStarts += firstRow
                val lines = h.lines
                var i = 0
                while (i < lines.size) {
                    if (mode == DiffMode.SPLIT && lines[i].kind == LineKind.REMOVED) {
                        val del = i
                        while (i < lines.size && lines[i].kind == LineKind.REMOVED) i++
                        val add = i
                        while (i < lines.size && lines[i].kind == LineKind.ADDED) i++
                        val nd = add - del
                        val na = i - add
                        for (k in 0 until maxOf(nd, na)) {
                            out += when {
                                k < nd && k < na -> DiffRow.Pair(f, gap, del + k, add + k)
                                k < nd -> DiffRow.Line(f, gap, del + k)
                                else -> DiffRow.Line(f, gap, add + k)
                            }
                        }
                        continue
                    }
                    out += DiffRow.Line(f, gap, i)
                    i++
                }
            }
        }
        rows = out
        fileRows = starts
        hunkRows = hunkStarts.toIntArray()
        for ((i, r) in rows.withIndex()) {
            for (side in Side.entries) rowLine(r, side)?.let { rowOf[Triple(r.file, side, it)] = i }
        }
    }

    fun line(f: Int, h: Int, i: Int) = files[f].hunks[h].lines[i]

    fun rowLine(r: DiffRow, side: Side): Int? = when (r) {
        is DiffRow.Ctx -> if (side == Side.OLD) r.old else r.new
        is DiffRow.Line -> line(r.file, r.hunk, r.index).number(side)
        is DiffRow.Pair -> line(r.file, r.hunk, if (side == Side.OLD) r.del else r.add).number(side)
        else -> null
    }

    fun rowOf(file: Int, at: LineRef): Int? = rowOf[Triple(file, at.side, at.line)]

    fun hidden(file: Int, gap: Int): Int? {
        val g = gaps.getOrNull(file)?.getOrNull(gap) ?: return null
        val (top, bottom) = revealed.getOrNull(file)?.getOrNull(gap) ?: (0 to 0)
        return g.len?.let { maxOf(it - top - bottom, 0) }
    }

    /** The rows a selection spans, first to last. */
    fun selectedRows(sel: LineRange): IntRange? {
        val a = rowOf(sel.file, sel.start) ?: return null
        val b = rowOf(sel.file, sel.end) ?: return null
        return minOf(a, b)..maxOf(a, b)
    }

    fun contains(sel: LineRange, at: LineRef): Boolean {
        val r = selectedRows(sel) ?: return false
        return rowOf(sel.file, at)?.let { it in r } ?: false
    }

    fun rowSelected(sel: LineRange?, row: Int, side: Side? = null): Boolean {
        sel ?: return false
        val r = selectedRows(sel) ?: return false
        if (rows[row].file != sel.file || row !in r) return false
        return side == null || side == sel.start.side || side == sel.end.side
    }

    /** The text of the selected lines on the selection's side, as rune's Cmd-C copies it. */
    fun selectedText(sel: LineRange): String? {
        val r = selectedRows(sel) ?: return null
        val side = sel.end.side
        return r.mapNotNull { i ->
            val row = rows[i]
            if (rowLine(row, side) == null) return@mapNotNull null
            when (row) {
                is DiffRow.Ctx -> files[row.file].contextLine(row.old, row.new)
                is DiffRow.Line -> line(row.file, row.hunk, row.index).text
                is DiffRow.Pair -> line(row.file, row.hunk, if (side == Side.OLD) row.del else row.add).text
                else -> null
            }
        }.joinToString("\n")
    }

    /** The gap a hidden line is folded in, if any. */
    fun gapHolding(file: Int, at: LineRef): Int? = gaps.getOrNull(file)?.indexOfFirst { g ->
        val first = if (at.side == Side.OLD) g.old else g.new
        at.line >= first && (g.len == null || at.line < first + g.len)
    }?.takeIf { it >= 0 }

    /** `revealed` after one expand of `file`'s gap. */
    fun expand(file: Int, gap: Int, how: Expand): Revealed {
        val hidden = hidden(file, gap) ?: return revealed
        if (hidden == 0 || !files[file].expandable) return revealed
        val last = gap == files[file].hunks.size
        val step = minOf(hidden, EXPAND_STEP)
        val (top, bottom) = revealed[file][gap]
        val next = when (how) {
            Expand.ALL -> (top + hidden) to bottom
            Expand.UP -> if (last) (top + step) to bottom else top to (bottom + step)
            Expand.DOWN -> (top + step) to bottom
        }
        return revealed.mapIndexed { f, g -> if (f != file) g else g.mapIndexed { i, r -> if (i == gap) next else r } }
    }

    /** A stable key per row, the same for a line in both modes. */
    fun key(r: DiffRow): String = when (r) {
        is DiffRow.File -> "df${r.file}"
        is DiffRow.Note -> "df${r.file}.note"
        is DiffRow.Fold -> "df${r.file}.g${r.gap}"
        is DiffRow.Ctx -> "df${r.file}.c${r.old}"
        is DiffRow.Line -> {
            val l = line(r.file, r.hunk, r.index)
            when (l.kind) {
                LineKind.CONTEXT -> "df${r.file}.c${l.old ?: 0}"
                LineKind.REMOVED -> "df${r.file}.o${l.old ?: 0}"
                LineKind.ADDED -> "df${r.file}.n${l.new ?: 0}"
            }
        }
        is DiffRow.Pair -> "df${r.file}.o${line(r.file, r.hunk, r.del).old ?: 0}"
    }
}
