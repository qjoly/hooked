package dev.qjoly.hooked.ui.kit

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.R

// hooked's colour schemes as desktop-rune paints them (theme.rs on top of rune-kit). 1 pt there is 1 dp here.

enum class Scheme(val key: String, val label: String, val swatch: Long) {
    COFFEE("default", "Coffee", 0xFF96684F), INDIGO("indigo", "Indigo", 0xFF7D74F5), LEGACY("legacy", "Legacy", 0xFFA07A55),
    DATADOG("datadog", "Datadog", 0xFF632CA6), GRUVBOX("gruvbox", "Gruvbox", 0xFFD65D0E), CLAUDE("claude", "Claude", 0xFFB14F32);

    companion object {
        fun of(key: String?) = entries.firstOrNull { it.key == key } ?: COFFEE
    }
}

enum class Appearance(val key: String, val label: String) {
    SYSTEM("system", "System"), LIGHT("light", "Light"), DARK("dark", "Dark");

    companion object {
        fun of(key: String?) = entries.firstOrNull { it.key == key } ?: SYSTEM
    }
}

enum class Corners(val key: String) {
    ROUND("round"), SHARP("sharp");

    companion object {
        fun of(key: String?) = entries.firstOrNull { it.key == key } ?: ROUND
    }
}

/** A state colour family: the hue, its soft fill and the ink that reads on that fill. */
@Immutable
data class Tone(val hue: Color, val soft: Color, val ink: Color) {
    val icon get() = hue
    val bg get() = soft
    val fg get() = ink
    val border get() = hue.copy(alpha = 0.45f)
}

private fun c(hex: Long) = Color(0xFF000000 or hex)
private fun tone(hue: Long, soft: Long, ink: Long = hue) = Tone(c(hue), c(soft), c(ink))

/** One scheme in one appearance, as `theme.rs::raw` lists it. `faint` and `l1` are rune-kit's derivations. */
@Immutable
data class Raw(
    val bg: Color, val surface: Color, val chip: Color, val border: Color, val border2: Color,
    val fg: Color, val muted: Color, val faint: Color, val accent: Color, val accentFg: Color,
    val info: Tone, val warning: Tone, val success: Tone, val danger: Tone,
    val working: Color, val background: Color, val idle: Color, val ended: Color, val l1: Color,
)

private fun raw(
    bg: Long, surface: Long, chip: Long, border: Long, border2: Long, fg: Long, muted: Long, faint: Long,
    accent: Long, accentFg: Long, info: Tone, warning: Tone, success: Tone, danger: Tone,
    working: Long, background: Long, idle: Long, ended: Long, l1: Long,
) = Raw(
    c(bg), c(surface), c(chip), c(border), c(border2), c(fg), c(muted), c(faint), c(accent), c(accentFg),
    info, warning, success, danger, c(working), c(background), c(idle), c(ended), c(l1),
)

private val RAW: Map<Pair<Scheme, Boolean>, Raw> = mapOf(
    (Scheme.COFFEE to false) to raw(
        0xe9ebdf, 0xffffff, 0xe3e4d7, 0xdadacd, 0xc7c4b7, 0x18110e, 0x6e6056, 0x86887d, 0x261b18, 0xfbfbf8,
        tone(0x418d50, 0xe8f1ea, 0x256b35), tone(0xe1901f, 0xfbefe0, 0x8b5500), tone(0x418d50, 0xe8f1ea, 0x256b35), tone(0xc43d4d, 0xf9eaeb, 0xa12437),
        0x418d50, 0x9e59b3, 0x92a1a9, 0x96684f, 0xe2e4d8,
    ),
    (Scheme.COFFEE to true) to raw(
        0x18110e, 0x261b18, 0x2f231f, 0x3a2d27, 0x4d3f37, 0xf2f3ec, 0xaaa497, 0x897f7b, 0xe4cdb1, 0x18110e,
        tone(0x70c47e, 0x323628), tone(0xf5ad5a, 0x473223), tone(0x70c47e, 0x323628), tone(0xed737b, 0x462928),
        0x70c47e, 0xca92dc, 0x6f7d84, 0xbe947d, 0x211a17,
    ),
    (Scheme.INDIGO to false) to raw(
        0xe7eaef, 0xffffff, 0xe3e6ec, 0xd3d8e0, 0xbcc3cd, 0x181b20, 0x5c636e, 0x83878d, 0x4f46e5, 0xffffff,
        tone(0x3b82c4, 0xe6eef8, 0x2f689d), tone(0xc08a1a, 0xf6efda, 0x845f12), tone(0x2a9d63, 0xe5f4ec, 0x1f7348), tone(0xdc4b3e, 0xfbede4, 0xb23d32),
        0x3b82c4, 0x8250df, 0xa6adb8, 0x2a9d63, 0xdfe4eb,
    ),
    (Scheme.INDIGO to true) to raw(
        0x101013, 0x1a1a1e, 0x212127, 0x34343c, 0x44444e, 0xececee, 0xa7a7b2, 0x7d7d81, 0x7d74f5, 0x13111d,
        tone(0x6aa5e0, 0x182634), tone(0xd9ad4a, 0x2e2717), tone(0x56c98a, 0x17281f), tone(0xec6a58, 0x2a1a16),
        0x6aa5e0, 0xa992e0, 0x6a6a74, 0x56c98a, 0x19191c,
    ),
    (Scheme.LEGACY to false) to raw(
        0xe9e3d4, 0xffffff, 0xece6d8, 0xe2dccd, 0xd6cdb9, 0x2f2b23, 0x7d7362, 0x878274, 0xb05a34, 0xffffff,
        tone(0x4f7d8c, 0xe4edf0, 0x2f689d), tone(0xc2912f, 0xf6eed6, 0x845f12), tone(0x7e9a68, 0xeaf0e2, 0x1f7348), tone(0xc0492c, 0xf7e6df, 0xb23d32),
        0x4f7d8c, 0x7a63b8, 0xa79f8d, 0x7e9a68, 0xe2dcce,
    ),
    (Scheme.LEGACY to true) to raw(
        0x15110d, 0x201a14, 0x2a231b, 0x342c23, 0x473c30, 0xece5d8, 0xa89e8d, 0x807a6f, 0xcf6f45, 0x13111d,
        tone(0x6fa4b5, 0x17242a), tone(0xd9a83f, 0x2b2413), tone(0x93b47a, 0x1c261a), tone(0xe06a4a, 0x2b1a13),
        0x6fa4b5, 0xa992e0, 0x8a8172, 0x93b47a, 0x1f1a11,
    ),
    (Scheme.DATADOG to false) to raw(
        0xf2f2f6, 0xffffff, 0xe9e9f0, 0xdcdce6, 0xc3c3d2, 0x1c1c22, 0x5c5c73, 0x8c8c94, 0x632ca6, 0xffffff,
        tone(0x0f74c4, 0xe4f0fb, 0x2f689d), tone(0xb3760f, 0xfbf1de, 0x845f12), tone(0x1f8f45, 0xe6f5ea, 0x1f7348), tone(0xcc2f22, 0xfbe9e7, 0xb23d32),
        0x1f8f45, 0x0f74c4, 0xa0a0b4, 0xa0a0b4, 0xebebf4,
    ),
    (Scheme.DATADOG to true) to raw(
        0x14141c, 0x1c1c26, 0x24242f, 0x33333f, 0x454553, 0xe9e9f0, 0x9d9db3, 0x7d7e88, 0xa78bfa, 0x13111d,
        tone(0x4aa3f0, 0x132534), tone(0xe0a92e, 0x2e2513), tone(0x4cc86b, 0x14291a), tone(0xef5f4e, 0x2c1714),
        0x4cc86b, 0x4aa3f0, 0x6b6b7d, 0x6b6b7d, 0x1d1d26,
    ),
    (Scheme.GRUVBOX to false) to raw(
        0xebdbb2, 0xfbf1c7, 0xebdbb2, 0xd5c4a1, 0xbdae93, 0x3c3836, 0x7c6f64, 0x8b7c56, 0xaf3a03, 0xfbf1c7,
        tone(0x076678, 0xdee0be, 0x2f689d), tone(0xb57614, 0xf3e2b2, 0x845f12), tone(0x79740e, 0xebe2b1, 0x1f7348), tone(0x9d0006, 0xf0d4b0, 0xb23d32),
        0x076678, 0x8f3f71, 0xa89984, 0x79740e, 0xe4d4ac,
    ),
    (Scheme.GRUVBOX to true) to raw(
        0x1d2021, 0x282828, 0x3c3836, 0x3c3836, 0x504945, 0xebdbb2, 0xa89984, 0x8c7d57, 0xfe8019, 0x282828,
        tone(0x83a598, 0x333735), tone(0xfabd2f, 0x413a29), tone(0xb8bb26, 0x393a28), tone(0xfb4934, 0x412c29),
        0x83a598, 0xd3869b, 0x7c6f64, 0xb8bb26, 0x2a2725,
    ),
    (Scheme.CLAUDE to false) to raw(
        0xf0eee6, 0xffffff, 0xeae7dc, 0xe8e5db, 0xd6d2c4, 0x141413, 0x6b6760, 0x8b8982, 0xb14f32, 0xffffff,
        tone(0x3d7fa6, 0xe4eef3, 0x2d6382), tone(0xc08a1a, 0xf6efdc, 0x8a5a16), tone(0x3a8c5f, 0xe4f0e8, 0x2c6b47), tone(0xc05c45, 0xf8e9e4, 0xa8402f),
        0x3d7fa6, 0x7a5ea8, 0xb5b0a4, 0x3a8c5f, 0xe9e7df,
    ),
    (Scheme.CLAUDE to true) to raw(
        0x1f1e1d, 0x30302e, 0x3a3a37, 0x3d3d3a, 0x4e4e4a, 0xf5f4ef, 0xa8a39a, 0x8a8985, 0xd97757, 0x1f1e1d,
        tone(0x6fa8d4, 0x1b2833), tone(0xd9a441, 0x332a17), tone(0x6cc08a, 0x1a2a20), tone(0xe8705c, 0x331f1b, 0xff866e),
        0x6fa8d4, 0xa98fd4, 0x6b6862, 0x6cc08a, 0x292824,
    ),
)

private val TAG_HUES_LIGHT = listOf(0x665d00, 0x006f5d, 0x006c7b, 0x005f99, 0x41559e, 0x8a3a64, 0xb42318, 0x9a4a00, 0x2b6a14, 0x632ca6, 0x55556a).map { c(it.toLong()) }
private val TAG_HUES_DARK = listOf(0xc6c17c, 0x78d1c0, 0x71cfd9, 0x8cc4f4, 0xa7bbf9, 0xeba6c6, 0xf19a8f, 0xf0b27a, 0x9fd68a, 0xc4a8fb, 0xb4b4c6).map { c(it.toLong()) }
private val SCHEME_TAG_HUES = listOf(0xc27a12, 0x0f8a7e, 0x2a9d63, 0xc62a9e, 0x7c4bd0, 0xd1493a).map { c(it.toLong()) }

/** rune-kit's colour tokens, resolved for one scheme and appearance. */
@Immutable
class KitColors(val raw: Raw, val dark: Boolean, private val scheme: Scheme) {
    val bg = raw.bg
    val surface = raw.surface
    val chip = raw.chip
    val border = raw.border
    val border2 = raw.border2
    val fg = raw.fg
    val muted = raw.muted
    val faint = raw.faint
    val accent = raw.accent
    val accentFg = raw.accentFg
    val info = raw.info
    val warning = raw.warning
    val success = raw.success
    val danger = raw.danger
    val l1 = raw.l1
    val hover = fg.copy(alpha = if (dark) 0.06f else 0.05f)
    val pressed = fg.copy(alpha = if (dark) 0.10f else 0.08f)
    val scrim = Color.Black.copy(alpha = 0.30f)
    val shadow = Color.Black.copy(alpha = if (dark) 0.30f else 0.12f)

    /** The six family hues, in wheel order: attention, waiting, working, background, idle, ended. */
    val hues = listOf(danger.hue, warning.hue, raw.working, raw.background, raw.idle, raw.ended)

    fun stateColor(state: String?) = when (state) {
        "attention" -> danger.hue
        "waiting" -> warning.hue
        "working" -> raw.working
        "background" -> raw.background
        "ended" -> raw.ended
        else -> raw.idle
    }

    fun tagHue(index: Int): Color = when {
        index < 6 && scheme != Scheme.COFFEE -> SCHEME_TAG_HUES[index]
        else -> (if (dark) TAG_HUES_DARK else TAG_HUES_LIGHT)[index.coerceIn(0, 10)]
    }

    /** The lot swatch beside a repo name on the Deck, Coffee only (the web's `lotColor`). */
    fun lotColor(key: String): Color? {
        if (scheme != Scheme.COFFEE) return null
        var h = 0L
        for (ch in key.substringAfterLast('/').lowercase()) h = (h * 31 + ch.code) and 0xffffffffL
        val light = listOf(0x918112, 0x524806, 0x0d8d82, 0x004e4e, 0x2b519c, 0xb3487e, 0x4b7bc0, 0x75254e)
        val darkList = listOf(0xc8b962, 0x8d813d, 0x68c4b8, 0x428787, 0x7398dc, 0xe88db6, 0x9ec0f2, 0xb26387)
        return c((if (dark) darkList else light)[(h % 8).toInt()].toLong())
    }
}

/** The radius scale, by scheme. Sharp corners zero it all. */
@Immutable
data class KitRadius(val xs: Dp, val sm: Dp, val md: Dp, val lg: Dp, val xl: Dp, val sharp: Boolean) {
    companion object {
        fun of(scheme: Scheme, corners: Corners) = when {
            corners == Corners.SHARP -> KitRadius(0.dp, 0.dp, 0.dp, 0.dp, 0.dp, true)
            scheme == Scheme.CLAUDE -> KitRadius(2.dp, 8.dp, 10.dp, 14.dp, 16.dp, false)
            scheme == Scheme.DATADOG -> KitRadius(2.dp, 3.dp, 3.dp, 3.dp, 3.dp, false)
            else -> KitRadius(2.dp, 4.dp, 6.dp, 8.dp, 10.dp, false)
        }
    }
}

private fun inter(weight: Int) = Font(R.font.inter, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

val Inter = FontFamily(listOf(400, 500, 600, 650, 670, 700, 750).map(::inter))
val Mono = FontFamily(Font(R.font.jetbrains_mono))

private fun style(size: Float, weight: Int, line: Float, family: FontFamily = Inter) = TextStyle(
    fontFamily = family,
    fontSize = size.sp,
    fontWeight = FontWeight(weight),
    lineHeight = line.sp,
    letterSpacing = TextUnit.Unspecified,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
)

/** rune-kit's text styles (`k.ty.*`), plus the few hooked adds. */
@Immutable
object KitType {
    val ui = style(13f, 400, 20f)
    val uiMedium = style(13f, 500, 20f)
    val uiCompact = style(13f, 400, 16f)
    val small = style(11f, 400, 12f)
    val smallMedium = style(11f, 500, 12f)
    val caption = style(11f, 400, 16f)
    val body = style(14f, 400, 21f)
    val bodyMedium = style(14f, 500, 21f)
    val textSmall = style(13f, 400, 19.5f)
    val textSmallMedium = style(13f, 500, 19.5f)
    val textXsmall = style(12f, 400, 18f)
    val textXsmallMedium = style(12f, 500, 18f)
    val mono = style(12f, 400, 18f, Mono)
    val tag = style(10.5f, 650, 17f)
    val tableCaption = style(10.5f, 700, 14f, Mono)
    val wheelCount = style(40f, 750, 42f)
    val markdown = style(14f, 400, 22.4f)
    val h1 = style(17f, 600, 24f)
    val h2 = style(15f, 600, 24f)
    val h3 = style(13f, 600, 20f)
}

@Immutable
class Kit(val scheme: Scheme, val c: KitColors, val r: KitRadius) {
    val ty = KitType
    val dark get() = c.dark
}

val LocalKit = staticCompositionLocalOf { Kit(Scheme.COFFEE, KitColors(RAW.getValue(Scheme.COFFEE to false), false, Scheme.COFFEE), KitRadius.of(Scheme.COFFEE, Corners.ROUND)) }

val k: Kit @Composable get() = LocalKit.current

@Composable
fun rememberKit(scheme: Scheme, appearance: Appearance, corners: Corners): Kit {
    val dark = when (appearance) {
        Appearance.SYSTEM -> isSystemInDarkTheme()
        Appearance.LIGHT -> false
        Appearance.DARK -> true
    }
    return Kit(scheme, KitColors(RAW.getValue(scheme to dark), dark, scheme), KitRadius.of(scheme, corners))
}

@Composable
fun ProvideKit(kit: Kit, content: @Composable () -> Unit) = CompositionLocalProvider(LocalKit provides kit, content = content)
