package dev.qjoly.hooked.ui.terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle
import dev.qjoly.hooked.R
import kotlin.math.abs
import kotlin.math.max

/** The cell grid of one font size: JetBrains Mono, rune's 1.5 line height, the glyph centred in its row. */
class TermFont(typeface: Typeface, val sizePx: Float, val cellH: Float) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.typeface = typeface
        textSize = sizePx
        isSubpixelText = true
    }

    /** rune measures ten M's and divides. */
    val cellW = paint.measureText("MMMMMMMMMM") / 10f
    val baseline: Float
    val strike: Float

    init {
        val fm = paint.fontMetrics
        baseline = (cellH - (fm.descent - fm.ascent)) / 2f - fm.ascent
        strike = baseline + (fm.ascent + fm.descent) / 4f
    }

    private val ascii = FloatArray(128) { if (it < 32) cellW else paint.measureText(it.toChar().toString()) }
    private val wide = HashMap<Int, Float>()

    /** Whether the font draws `cp` over the `w` columns wcwidth gives it; Termux scales the ones it does not. */
    fun fits(cp: Int, w: Int, text: CharArray, start: Int, end: Int): Boolean {
        val m = if (cp < 128) ascii[cp] else wide.getOrPut(cp) { paint.measureText(text, start, Character.charCount(cp).coerceAtMost(end - start)) }
        return abs(m / cellW - w) <= 0.01f
    }

    companion object {
        private var mono: Typeface? = null

        fun of(ctx: Context, sizePx: Float, cellH: Float): TermFont {
            val tf = mono ?: (runCatching { ctx.resources.getFont(R.font.jetbrains_mono) }.getOrNull() ?: Typeface.MONOSPACE).also { mono = it }
            return TermFont(tf, sizePx, cellH)
        }
    }
}

/** What a frame shows beyond the screen itself, in device pixels and ARGB. */
class PaintState(
    val pad: Float,
    val dp: Float,
    val sel: Sel?,
    val needle: String,
    val preedit: String,
    val selColor: Int,
    val matchColor: Int,
    val handleColor: Int,
)

/**
 * Paints a terminal as rune's view does: cell backgrounds as full-height runs, then the selection,
 * search matches and cursor as marks, then the text in runs of one style, URLs underlined, and the
 * scrollbar. Ghostty's conventions hold: bold is a heavier face, never a brighter colour, and faint
 * text is drawn at 60 %.
 */
class TermPainter {
    private val fill = Paint()
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG)
    private val cells = Cells()
    private val rect = RectF()

    fun paint(c: Canvas, t: Term, f: TermFont, s: PaintState, width: Float, height: Float) {
        // drawColor fills the whole layer otherwise: Compose does not clip a node to its bounds.
        val saved = c.save()
        c.clipRect(0f, 0f, width, height)
        try {
            paintIn(c, t, f, s, width, height)
        } finally {
            c.restoreToCount(saved)
        }
    }

    private fun paintIn(c: Canvas, t: Term, f: TermFont, s: PaintState, width: Float, height: Float) {
        val em: TerminalEmulator = t.emulator
        val screen = em.screen
        val pal = em.mColors.mCurrentColors
        val rev = em.isReverseVideo
        val defFg = pal[TextStyle.COLOR_INDEX_FOREGROUND]
        val defBg = pal[TextStyle.COLOR_INDEX_BACKGROUND]
        val bg = if (rev) defFg else defBg
        val fg = if (rev) defBg else defFg
        c.drawColor(bg)

        ink.typeface = f.paint.typeface
        ink.textSize = f.sizePx
        ink.isSubpixelText = true
        val cols = em.mColumns
        val rows = em.mRows
        val top = t.top
        val cw = f.cellW
        val ch = f.cellH
        val pad = s.pad
        val cursorRow = em.cursorRow - top
        val cursorCol = em.cursorCol
        val cursorShown = !t.exited && em.isCursorEnabled && s.preedit.isEmpty() && cursorRow in 0 until rows
        val block = em.cursorStyle == TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
        val cursorColor = pal[TextStyle.COLOR_INDEX_CURSOR]

        for (i in 0 until rows) {
            val row = top + i
            val line = screen.allocateFullLineIfNecessary(screen.externalToInternalRow(row))
            val text = line.mText
            cells.scan(text, line.spaceUsed, cols)
            val y = pad + i * ch

            // Backgrounds, merged into runs of one colour.
            var runA = -1
            var runB = 0
            var runC = 0
            for (k in 0 until cells.count) {
                val col = cells.col[k]
                val w = cells.width[k]
                if (w == 0) continue
                val b = cellColors(line.getStyle(col), pal, rev, false)
                if (b != bg) {
                    if (runA >= 0 && runC == b && runB == col) runB = col + w
                    else {
                        if (runA >= 0) cellRect(c, runA, runB, y, runC, pad, cw, ch)
                        runA = col; runB = col + w; runC = b
                    }
                } else if (runA >= 0) {
                    cellRect(c, runA, runB, y, runC, pad, cw, ch)
                    runA = -1
                }
            }
            if (runA >= 0) cellRect(c, runA, runB, y, runC, pad, cw, ch)

            // Marks over the backgrounds.
            s.sel?.rowRange(row, cols)?.let { (a, b) -> cellRect(c, a, b, y, s.selColor, pad, cw, ch) }
            val rowText = if (s.needle.isNotEmpty() || hasScheme(text, line.spaceUsed)) RowText.of(text, cells) else null
            if (s.needle.isNotEmpty() && rowText != null) {
                for ((a, b) in matches(rowText, s.needle)) cellRect(c, a, b, y, s.matchColor, pad, cw, ch)
            }
            val cursorHere = cursorShown && i == cursorRow
            var cursorEnd = cursorCol + 1
            if (cursorHere) {
                val k = cells.at(cursorCol)
                if (k >= 0) cursorEnd = cursorCol + max(cells.width[k], 1)
                cellRect(c, cursorCol, cursorEnd, y, if (block) cursorColor else alpha(cursorColor, 0.35f), pad, cw, ch)
            }

            // Text, in runs that share a style; glyphs the font draws at the wrong width get their own scaled run.
            var k = 0
            while (k < cells.count) {
                val col = cells.col[k]
                val style = line.getStyle(col)
                val underCursor = cursorHere && block && col >= cursorCol && col < cursorEnd
                val fits = f.fits(cells.point[k], cells.width[k], text, cells.start[k], cells.end[k])
                var e = k + 1
                if (fits && !underCursor) {
                    while (e < cells.count) {
                        val c2 = cells.col[e]
                        if (line.getStyle(c2) != style) break
                        if (cursorHere && block && c2 >= cursorCol && c2 < cursorEnd) break
                        if (!f.fits(cells.point[e], cells.width[e], text, cells.start[e], cells.end[e])) break
                        e++
                    }
                }
                val endCol = cells.col[e - 1] + cells.width[e - 1]
                drawRun(c, text, cells.start[k], cells.end[e - 1], col, endCol, style, y, f, pal, rev, if (underCursor) bg else null, !fits, pad)
                k = e
            }

            // Plain URLs, underlined as rune does.
            if (rowText != null && hasScheme(text, line.spaceUsed)) {
                for (l in links(rowText)) {
                    fill.color = alpha(fg, 0.6f)
                    c.drawRect(pad + l.a * cw, y + f.baseline + 2 * s.dp, pad + l.b * cw, y + f.baseline + 3 * s.dp, fill)
                }
            }
        }

        // The input method's composition, drawn at the cursor.
        if (s.preedit.isNotEmpty() && cursorRow in 0 until rows) {
            val x = pad + cursorCol * cw
            val y = pad + cursorRow * ch
            ink.color = fg
            ink.isFakeBoldText = false
            ink.textSkewX = 0f
            val w = ink.measureText(s.preedit)
            fill.color = bg
            c.drawRect(x, y, x + w, y + ch, fill)
            c.drawText(s.preedit, x, y + f.baseline, ink)
            fill.color = fg
            c.drawRect(x, y + ch - s.dp, x + w, y + ch, fill)
        }

        // Selection handles, for touch.
        s.sel?.takeIf { !it.empty }?.ordered()?.let { (a, b) ->
            fill.color = s.handleColor
            val r = 6 * s.dp
            if (a.row - top in 0 until rows) c.drawCircle(pad + a.col * cw, pad + (a.row - top + 1) * ch + r * 0.6f, r, fill)
            if (b.row - top in 0 until rows) c.drawCircle(pad + (b.col + 1) * cw, pad + (b.row - top + 1) * ch + r * 0.6f, r, fill)
        }

        // rune's scrollbar: a 3 pt thumb 6 pt from the right edge.
        scrollPos(t.transcript, rows, top)?.let { p ->
            val h = (height - 16 * s.dp).coerceAtLeast(10 * s.dp)
            val y0 = h * p.offset / p.total
            val size = (h * p.len / p.total).coerceAtLeast(12 * s.dp)
            fill.color = alpha(fg, 0.35f)
            rect.set(width - 6 * s.dp, 8 * s.dp + y0, width - 3 * s.dp, 8 * s.dp + y0 + size)
            c.drawRoundRect(rect, 1.5f * s.dp, 1.5f * s.dp, fill)
        }
    }

    private fun cellRect(c: Canvas, a: Int, b: Int, y: Float, color: Int, pad: Float, cw: Float, ch: Float) {
        fill.color = color
        c.drawRect(pad + a * cw, y, pad + b * cw, y + ch, fill)
    }

    private fun drawRun(
        c: Canvas, text: CharArray, start: Int, end: Int, col: Int, endCol: Int, style: Long, y: Float,
        f: TermFont, pal: IntArray, rev: Boolean, cursorInk: Int?, scale: Boolean, pad: Float,
    ) {
        val effect = TextStyle.decodeEffect(style)
        if (effect and TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE != 0) return
        val underline = effect and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE != 0
        val strike = effect and TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH != 0
        if (!underline && !strike && blank(text, start, end)) return
        var color = cursorInk ?: cellColors(style, pal, rev, true)
        if (effect and TextStyle.CHARACTER_ATTRIBUTE_DIM != 0) color = alpha(color, 0.6f)
        ink.color = color
        ink.isFakeBoldText = effect and TextStyle.CHARACTER_ATTRIBUTE_BOLD != 0
        ink.textSkewX = if (effect and TextStyle.CHARACTER_ATTRIBUTE_ITALIC != 0) -0.25f else 0f
        val x = pad + col * f.cellW
        val x1 = pad + endCol * f.cellW
        val n = end - start
        if (n > 0) {
            val m = if (scale) ink.measureText(text, start, n) else 0f
            if (scale && m > 0f) {
                c.save()
                c.scale((x1 - x) / m, 1f, x, 0f)
                c.drawText(text, start, n, x, y + f.baseline, ink)
                c.restore()
            } else {
                c.drawText(text, start, n, x, y + f.baseline, ink)
            }
        }
        val thick = (f.sizePx / 12f).coerceAtLeast(1f)
        if (underline) {
            fill.color = color
            c.drawRect(x, y + f.cellH - 3 * thick, x1, y + f.cellH - 2 * thick, fill)
        }
        if (strike) {
            fill.color = color
            c.drawRect(x, y + f.strike, x1, y + f.strike + thick, fill)
        }
    }

    companion object {
        /** A cell's ink (`fg`) or ground, inverse video applied. */
        fun cellColors(style: Long, pal: IntArray, rev: Boolean, fg: Boolean): Int {
            val effect = TextStyle.decodeEffect(style)
            val swap = rev xor (effect and TextStyle.CHARACTER_ATTRIBUTE_INVERSE != 0)
            val wantFore = fg xor swap
            return TermPalette.resolve(if (wantFore) TextStyle.decodeForeColor(style) else TextStyle.decodeBackColor(style), pal)
        }

        fun alpha(color: Int, a: Float): Int = (color and 0xFFFFFF) or (((color ushr 24) * a).toInt() shl 24)

        private fun blank(text: CharArray, start: Int, end: Int): Boolean {
            for (i in start until end) if (text[i] != ' ') return false
            return true
        }

        /** A cheap test for `://` before a row is turned into a string. */
        fun hasScheme(text: CharArray, used: Int): Boolean {
            val n = minOf(used, text.size)
            for (i in 0 until n - 2) if (text[i] == ':' && text[i + 1] == '/' && text[i + 2] == '/') return true
            return false
        }
    }
}
