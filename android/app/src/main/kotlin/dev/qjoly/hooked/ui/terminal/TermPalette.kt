package dev.qjoly.hooked.ui.terminal

import com.termux.terminal.TerminalColors
import com.termux.terminal.TextStyle

/** rune's terminal colours (ghostty.rs): Ghostty's defaults on the dark ground, GitHub's ANSI set on the light one. */
object TermPalette {
    const val FG_DARK = 0xFFE9E9F0.toInt()
    const val BG_DARK = 0xFF0D0D13.toInt()
    const val FG_LIGHT = 0xFF1F2328.toInt()
    const val BG_LIGHT = 0xFFFFFFFF.toInt()

    // Ghostty's built-in palette, what `default_color_palette()` hands rune in the dark.
    private val DARK_ANSI = intArrayOf(
        0x1d1f21, 0xcc6666, 0xb5bd68, 0xf0c674, 0x81a2be, 0xb294bb, 0x8abeb7, 0xc5c8c6,
        0x666666, 0xd54e53, 0xb9ca4a, 0xe7c547, 0x7aa6da, 0xc397d8, 0x70c0b1, 0xeaeaea,
    )
    private val LIGHT_ANSI = intArrayOf(
        0x24292f, 0xcf222e, 0x116329, 0x4d2d00, 0x0969da, 0x8250df, 0x1b7c83, 0x6e7781,
        0x57606a, 0xa40e26, 0x1a7f37, 0x633c01, 0x218bff, 0xa475f9, 0x3192aa, 0x8c959f,
    )

    /** The 259 indexed colours Termux resolves against: 16 ANSI, the 6×6×6 cube, 24 greys, then fg, bg and cursor. */
    fun colors(dark: Boolean): IntArray {
        val out = IntArray(TextStyle.NUM_INDEXED_COLORS)
        val ansi = if (dark) DARK_ANSI else LIGHT_ANSI
        for (i in 0 until 16) out[i] = 0xFF000000.toInt() or ansi[i]
        val steps = intArrayOf(0, 0x5f, 0x87, 0xaf, 0xd7, 0xff)
        for (i in 0 until 216) out[16 + i] = rgb(steps[i / 36], steps[i / 6 % 6], steps[i % 6])
        for (i in 0 until 24) (8 + 10 * i).let { out[232 + i] = rgb(it, it, it) }
        val fg = if (dark) FG_DARK else FG_LIGHT
        out[TextStyle.COLOR_INDEX_FOREGROUND] = fg
        out[TextStyle.COLOR_INDEX_BACKGROUND] = if (dark) BG_DARK else BG_LIGHT
        out[TextStyle.COLOR_INDEX_CURSOR] = fg
        return out
    }

    private fun rgb(r: Int, g: Int, b: Int) = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    private var installed: Boolean? = null

    /** Makes these the defaults a terminal reset (RIS, OSC 104) falls back to; Termux keeps them process-wide. */
    fun install(dark: Boolean) {
        if (installed == dark) return
        installed = dark
        colors(dark).copyInto(TerminalColors.COLOR_SCHEME.mDefaultColors)
    }

    /** A Termux colour: an index into `palette`, or an opaque RGB already. */
    fun resolve(color: Int, palette: IntArray): Int =
        if (color and 0xFF000000.toInt() == 0xFF000000.toInt()) color else palette.getOrElse(color) { palette[TextStyle.COLOR_INDEX_FOREGROUND] }
}
