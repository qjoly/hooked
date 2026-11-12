package dev.qjoly.hooked.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.R
import dev.qjoly.hooked.data.SessionState

/** Roast neutral ladder and espresso/latte interaction colours from DESIGN.md, as on the web and iOS. */
@Immutable
data class HookedColors(
    val ground: Color,
    val card: Color,
    val panel: Color,
    val line: Color,
    val ink: Color,
    val muted: Color,
    val accent: Color,
    val onAccent: Color,
    val userBubble: Color,
    val userText: Color,
    val code: Color,
    val codeFg: Color,
    val crema: Color,
    val link: Color,
    val dark: Boolean,
)

private val Light = HookedColors(
    ground = Color(0xFFE9EBDF), card = Color(0xFFFFFFFF), panel = Color(0xFFF2F3EC), line = Color(0xFFDADACD),
    ink = Color(0xFF18110E), muted = Color(0xFF6E6056), accent = Color(0xFF261B18), onAccent = Color(0xFFFBFBF8),
    userBubble = Color(0xFF261B18), userText = Color(0xFFFBFBF8), code = Color(0xFF1E1512), codeFg = Color(0xFFE8E1D6),
    crema = Color(0xFFF3E5D9), link = Color(0xFF76482D), dark = false,
)

private val Dark = HookedColors(
    ground = Color(0xFF18110E), card = Color(0xFF261B18), panel = Color(0xFF1E1512), line = Color(0xFF3A2D27),
    ink = Color(0xFFF2F3EC), muted = Color(0xFFAAA497), accent = Color(0xFFE4CDB1), onAccent = Color(0xFF1E1512),
    userBubble = Color(0xFF3A2D27), userText = Color(0xFFFBFBF8), code = Color(0xFF110A09), codeFg = Color(0xFFE8E1D6),
    crema = Color(0xFF3A2A1F), link = Color(0xFFD9AD8A), dark = true,
)

val LocalHooked = staticCompositionLocalOf { Light }

val hooked: HookedColors @Composable get() = LocalHooked.current

private fun variable(res: Int, weight: Int) =
    Font(res, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

/** The web dashboard's Coffee fonts. */
val Body = FontFamily(listOf(400, 500, 600, 700, 800).map { variable(R.font.schibsted_grotesk, it) })
val Display = FontFamily(listOf(500, 600, 700, 800).map { variable(R.font.bricolage_grotesque, it) })
val Mono = FontFamily(Font(R.font.jetbrains_mono))

private fun typography(): Typography {
    val base = Typography()
    fun TextStyle.body() = copy(fontFamily = Body)
    fun TextStyle.display() = copy(fontFamily = Display, fontWeight = FontWeight.Bold)
    return Typography(
        displayLarge = base.displayLarge.display(), displayMedium = base.displayMedium.display(), displaySmall = base.displaySmall.display(),
        headlineLarge = base.headlineLarge.display(), headlineMedium = base.headlineMedium.display(), headlineSmall = base.headlineSmall.display(),
        titleLarge = base.titleLarge.copy(fontFamily = Display, fontWeight = FontWeight.SemiBold),
        titleMedium = base.titleMedium.copy(fontFamily = Body, fontWeight = FontWeight.SemiBold),
        titleSmall = base.titleSmall.copy(fontFamily = Body, fontWeight = FontWeight.SemiBold),
        bodyLarge = base.bodyLarge.body(), bodyMedium = base.bodyMedium.body(), bodySmall = base.bodySmall.body(),
        labelLarge = base.labelLarge.copy(fontFamily = Body, fontWeight = FontWeight.SemiBold),
        labelMedium = base.labelMedium.copy(fontFamily = Body, fontWeight = FontWeight.SemiBold),
        labelSmall = base.labelSmall.copy(fontFamily = Body, fontWeight = FontWeight.SemiBold),
    )
}

@Composable
fun HookedTheme(content: @Composable () -> Unit) {
    val c = if (isSystemInDarkTheme()) Dark else Light
    val scheme = if (c.dark) {
        darkColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.crema, onPrimaryContainer = c.ink,
            secondary = Color(0xFFBE947D), onSecondary = c.onAccent, secondaryContainer = Color(0xFF3A2D27), onSecondaryContainer = c.ink,
            background = c.ground, onBackground = c.ink, surface = c.ground, onSurface = c.ink,
            surfaceVariant = c.panel, onSurfaceVariant = c.muted, outline = c.line, outlineVariant = c.line,
            surfaceContainerLowest = Color(0xFF120C0A), surfaceContainerLow = c.panel, surfaceContainer = Color(0xFF221815),
            surfaceContainerHigh = c.card, surfaceContainerHighest = Color(0xFF2E221E),
            error = Color(0xFFED737B), onError = c.onAccent,
        )
    } else {
        lightColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.crema, onPrimaryContainer = c.ink,
            secondary = Color(0xFF96684F), onSecondary = c.onAccent, secondaryContainer = Color(0xFFE4CDB1), onSecondaryContainer = c.ink,
            background = c.ground, onBackground = c.ink, surface = c.ground, onSurface = c.ink,
            surfaceVariant = c.panel, onSurfaceVariant = c.muted, outline = c.line, outlineVariant = c.line,
            surfaceContainerLowest = c.card, surfaceContainerLow = c.panel, surfaceContainer = Color(0xFFEDEEE4),
            surfaceContainerHigh = c.card, surfaceContainerHighest = Color(0xFFE2E4D7),
            error = Color(0xFFA12437), onError = c.onAccent,
        )
    }
    CompositionLocalProvider(LocalHooked provides c) {
        MaterialTheme(
            colorScheme = scheme,
            typography = typography(),
            shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(14.dp), large = RoundedCornerShape(18.dp)),
            content = content,
        )
    }
}

enum class MarkShape { DIAMOND, DISC, RING, HAIRLINE, SQUARE }

/** A state family: label, shape and hue, never hue alone. */
@Immutable
data class StateStyle(val label: String, val shape: MarkShape, val hue: Color, val ink: Color, val pulses: Boolean) {
    val soft get() = hue.copy(alpha = 0.14f)

    companion object {
        fun of(s: SessionState, dark: Boolean): StateStyle {
            fun c(light: Long, darkHex: Long) = Color(if (dark) darkHex else light)
            return when (s) {
                SessionState.ATTENTION -> StateStyle("Attention", MarkShape.DIAMOND, c(0xFFC43D4D, 0xFFED737B), c(0xFFA12437, 0xFFED737B), true)
                SessionState.WAITING -> StateStyle("Waiting", MarkShape.DISC, c(0xFFE1901F, 0xFFF5AD5A), c(0xFF8B5500, 0xFFF5AD5A), true)
                SessionState.WORKING -> StateStyle("Working", MarkShape.DISC, c(0xFF418D50, 0xFF70C47E), c(0xFF256B35, 0xFF70C47E), true)
                SessionState.BACKGROUND -> StateStyle("Background", MarkShape.RING, c(0xFF9E59B3, 0xFFCA92DC), c(0xFF804293, 0xFFCA92DC), true)
                SessionState.ENDED, SessionState.PAST -> StateStyle(s.label, MarkShape.SQUARE, c(0xFF96684F, 0xFFBE947D), c(0xFF724A34, 0xFFBE947D), false)
                else -> StateStyle("Idle", MarkShape.HAIRLINE, c(0xFF92A1A9, 0xFF6F7D84), c(0xFF6E6056, 0xFFAAA497), false)
            }
        }
    }
}

@Composable
fun stateStyle(s: SessionState) = StateStyle.of(s, hooked.dark)

/** Pending question, permission or plan: the attention family, as on the web. */
@Composable
fun decisionStyle() = StateStyle.of(SessionState.ATTENTION, hooked.dark)

@Composable
fun StateDot(style: StateStyle, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    val alpha = if (style.pulses) {
        val t = rememberInfiniteTransition(label = "pulse")
        val a by t.animateFloat(1f, 0.35f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "alpha")
        a
    } else {
        1f
    }
    Canvas(modifier.size(size).alpha(alpha)) {
        val d = this.size.minDimension
        when (style.shape) {
            MarkShape.DISC -> drawCircle(style.hue)
            MarkShape.RING -> drawCircle(style.hue, radius = d * 0.35f, style = Stroke(d * 0.3f))
            MarkShape.HAIRLINE -> drawCircle(style.hue, radius = d * 0.45f, style = Stroke(1.dp.toPx()))
            MarkShape.SQUARE -> drawRect(style.hue, Offset(d * 0.075f, d * 0.075f), Size(d * 0.85f, d * 0.85f))
            MarkShape.DIAMOND -> rotate(45f) {
                val s = d * 0.78f
                drawRect(style.hue, Offset((d - s) / 2, (d - s) / 2), Size(s, s))
            }
        }
    }
}

@Composable
fun StatePill(style: StateStyle, modifier: Modifier = Modifier, label: String? = null) {
    Row(
        modifier.background(style.soft, RoundedCornerShape(50)).padding(start = 8.dp, end = 9.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        StateDot(style)
        Text((label ?: style.label).uppercase(), color = style.ink, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.6.sp)
    }
}
