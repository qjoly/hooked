package dev.qjoly.hooked.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.Inter
import dev.qjoly.hooked.ui.kit.Kit
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.k

// The first port's vocabulary, now read from the rune kit so every screen follows the six schemes.

@Immutable
data class HookedColors(
    val ground: Color, val card: Color, val panel: Color, val line: Color, val ink: Color, val muted: Color,
    val accent: Color, val onAccent: Color, val userBubble: Color, val userText: Color, val code: Color, val codeFg: Color,
    val crema: Color, val link: Color, val dark: Boolean,
)

val hooked: HookedColors
    @Composable get() {
        val kit = k
        return remember(kit) {
            val c = kit.c
            HookedColors(
                ground = c.bg, card = c.surface, panel = c.chip, line = c.border, ink = c.fg, muted = c.muted,
                accent = c.accent, onAccent = c.accentFg, userBubble = c.accent, userText = c.accentFg,
                code = c.surface, codeFg = c.fg, crema = c.chip, link = c.accent, dark = c.dark,
            )
        }
    }

val Body: FontFamily = Inter
val Display: FontFamily = Inter
val Mono: FontFamily = dev.qjoly.hooked.ui.kit.Mono

@Composable
fun HookedTheme(kit: Kit, content: @Composable () -> Unit) {
    val c = kit.c
    val scheme = if (c.dark) {
        darkColorScheme(
            primary = c.accent, onPrimary = c.accentFg, primaryContainer = c.chip, onPrimaryContainer = c.fg,
            secondary = c.muted, onSecondary = c.bg, secondaryContainer = c.chip, onSecondaryContainer = c.fg,
            background = c.bg, onBackground = c.fg, surface = c.bg, onSurface = c.fg,
            surfaceVariant = c.chip, onSurfaceVariant = c.muted, outline = c.border, outlineVariant = c.border,
            surfaceContainerLowest = c.bg, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
            surfaceContainerHigh = c.surface, surfaceContainerHighest = c.chip,
            error = c.danger.fg, onError = c.accentFg,
        )
    } else {
        lightColorScheme(
            primary = c.accent, onPrimary = c.accentFg, primaryContainer = c.chip, onPrimaryContainer = c.fg,
            secondary = c.muted, onSecondary = c.bg, secondaryContainer = c.chip, onSecondaryContainer = c.fg,
            background = c.bg, onBackground = c.fg, surface = c.bg, onSurface = c.fg,
            surfaceVariant = c.chip, onSurfaceVariant = c.muted, outline = c.border, outlineVariant = c.border,
            surfaceContainerLowest = c.surface, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
            surfaceContainerHigh = c.surface, surfaceContainerHighest = c.chip,
            error = c.danger.fg, onError = c.accentFg,
        )
    }
    val base = Typography()
    fun androidx.compose.ui.text.TextStyle.inter() = copy(fontFamily = Inter)
    val typography = Typography(
        displayLarge = base.displayLarge.inter(), displayMedium = base.displayMedium.inter(), displaySmall = base.displaySmall.inter(),
        headlineLarge = base.headlineLarge.inter(), headlineMedium = base.headlineMedium.inter(), headlineSmall = base.headlineSmall.inter(),
        titleLarge = kit.ty.h1, titleMedium = kit.ty.bodyMedium, titleSmall = kit.ty.textSmallMedium,
        bodyLarge = kit.ty.body, bodyMedium = kit.ty.textSmall, bodySmall = kit.ty.textXsmall,
        labelLarge = kit.ty.uiMedium, labelMedium = kit.ty.textXsmallMedium, labelSmall = kit.ty.smallMedium,
    )
    ProvideKit(kit) {
        MaterialTheme(
            colorScheme = scheme,
            typography = typography,
            shapes = Shapes(small = RoundedCornerShape(kit.r.sm), medium = RoundedCornerShape(kit.r.md), large = RoundedCornerShape(kit.r.lg)),
            content = content,
        )
    }
}

enum class MarkShape { DIAMOND, DISC, RING, HAIRLINE, SQUARE }

/** A state family: label, hue and ink from the kit. */
@Immutable
data class StateStyle(val label: String, val shape: MarkShape, val hue: Color, val ink: Color, val pulses: Boolean) {
    val soft get() = hue.copy(alpha = 0.14f)
}

@Composable
fun stateStyle(s: SessionState): StateStyle {
    val c = k.c
    return when (s) {
        SessionState.ATTENTION -> StateStyle("Attention", MarkShape.DISC, c.danger.hue, c.danger.ink, false)
        SessionState.WAITING -> StateStyle("Waiting", MarkShape.DISC, c.warning.hue, c.warning.ink, false)
        SessionState.WORKING -> StateStyle("Working", MarkShape.DISC, c.stateColor("working"), c.success.ink, false)
        SessionState.BACKGROUND -> StateStyle("Background", MarkShape.DISC, c.stateColor("background"), c.stateColor("background"), false)
        SessionState.ENDED, SessionState.PAST -> StateStyle(s.label, MarkShape.DISC, c.stateColor("ended"), c.muted, false)
        else -> StateStyle("Idle", MarkShape.DISC, c.stateColor("idle"), c.muted, false)
    }
}

/** Pending question, permission or plan: the danger family. */
@Composable
fun decisionStyle() = stateStyle(SessionState.ATTENTION)

@Composable
fun StateDot(style: StateStyle, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    val alpha = if (style.pulses) {
        val t = rememberInfiniteTransition(label = "pulse")
        val a by t.animateFloat(1f, 0.35f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "alpha")
        a
    } else {
        1f
    }
    Dot(style.hue, size, modifier.alpha(alpha))
}

@Composable
fun StatePill(style: StateStyle, modifier: Modifier = Modifier, label: String? = null) {
    Row(
        modifier.height(22.dp).clip(RoundedCornerShape(11.dp)).background(k.c.chip).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Dot(style.hue, 7.dp)
        Text(label ?: style.label, style = k.ty.textXsmallMedium, color = k.c.muted)
    }
}
