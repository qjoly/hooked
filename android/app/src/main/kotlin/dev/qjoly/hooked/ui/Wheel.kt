package dev.qjoly.hooked.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.state.Slice
import dev.qjoly.hooked.state.familyOf
import dev.qjoly.hooked.state.stateLabel
import dev.qjoly.hooked.state.wheelGap
import dev.qjoly.hooked.ui.kit.k
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.hypot

/** An arc of `frac` × the circle starting at `start`, clockwise from 12 o'clock, minus half the gap at each end. */
private fun DrawScope.arc(color: Color, center: Offset, r: Float, width: Float, start: Float, end: Float, gap: Float, alpha: Float = 1f) {
    val len = ((end - start) - gap).coerceAtLeast(0.5f / (2 * PI.toFloat() * r))
    drawArc(
        color = color.copy(alpha = color.alpha * alpha),
        startAngle = -90f + (start + gap / 2) * 360f,
        sweepAngle = len * 360f,
        useCenter = false,
        topLeft = Offset(center.x - r, center.y - r),
        size = Size(2 * r, 2 * r),
        style = Stroke(width, cap = StrokeCap.Butt),
    )
}

/** The top bar's mini fleet wheel (`logo.rs`): an accent core, one ring arc per family, the hook glyph. */
@Composable
fun Logo(sessions: List<Session>, size: Dp = 26.dp) {
    val c = k.c
    val counts = IntArray(6).also { a -> sessions.forEach { a[familyOf(it)]++ } }
    val total = counts.sum()
    val hook = remember64()
    Canvas(Modifier.size(size)) {
        scale(this.size.minDimension / 64f, Offset.Zero) {
            val center = Offset(32f, 32f)
            drawCircle(c.accent, 22f, center)
            if (total == 0) {
                drawCircle(c.border2, 27f, center, style = Stroke(7f))
            } else {
                val gap = wheelGap(total)
                var start = 0f
                counts.forEachIndexed { i, n ->
                    if (n == 0) return@forEachIndexed
                    val end = start + n.toFloat() / total
                    arc(c.hues[i], center, 27f, 7f, start, end, gap)
                    start = end
                }
            }
            hook.forEach { drawPath(it, c.accentFg, style = Stroke(5.5f, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round)) }
        }
    }
}

private val HOOK = listOf("M32 15v18", "M32 33a8.5 8.5 0 1 1-8.5 8.5", "M26.5 15h11")

@Composable
private fun remember64() = androidx.compose.runtime.remember { HOOK.map { PathParser().parsePathString(it).toPath() } }

/**
 * The Deck's wheel (`fleet.rs::wheel_svg`): per family an inner arc, per session an outer arc, attention
 * and waiting pulled out. A tap highlights a session; tapping it again opens it.
 */
@Composable
fun FleetWheel(
    slices: List<Slice>,
    decisions: Int,
    filter: Int?,
    hovered: String?,
    onHover: (String?) -> Unit,
    onOpen: (String) -> Unit,
    title: (Session) -> String,
    size: Dp = 172.dp,
) {
    val c = k.c
    val n = slices.size
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(
            Modifier.size(size).pointerInput(slices) {
                detectTapGestures { p ->
                    val s = this.size.width / 200f
                    val dx = p.x / s - 100f
                    val dy = p.y / s - 100f
                    val r = hypot(dx, dy)
                    if (r < 70f || r > 94f || n == 0) {
                        onHover(null)
                        return@detectTapGestures
                    }
                    val t = ((atan2(dx, -dy) / (2 * PI)).toFloat() + 1f) % 1f
                    val hit = slices.firstOrNull { t >= it.start && t < it.end } ?: slices.last()
                    if (hovered == hit.session.id) onOpen(hit.session.id) else onHover(hit.session.id)
                }
            },
        ) {
            scale(this.size.minDimension / 200f, Offset.Zero) {
                val center = Offset(100f, 100f)
                if (n == 0) {
                    drawCircle(c.hues[5], 80f, center, style = Stroke(14f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 6f))))
                    return@scale
                }
                val gap = wheelGap(n)
                // Inner ring: one arc per family present, spanning its members.
                slices.groupBy { it.family }.forEach { (f, members) ->
                    val dim = filter != null && filter != f
                    arc(c.hues[f], center, 60f, 9f, members.first().start, members.last().end, gap, if (dim) 0.14f else 0.55f)
                }
                for (s in slices) {
                    val dim = filter != null && filter != s.family
                    val alpha = when {
                        dim -> 0.14f
                        s.quiet -> 0.4f
                        else -> 1f
                    }
                    val width = if (hovered == s.session.id) 19f else 14f
                    arc(c.hues[s.family], center, if (s.pulled) 85f else 79f, width, s.start, s.end, gap, alpha)
                }
            }
        }
        val hover = slices.firstOrNull { it.session.id == hovered }?.session
        if (hover != null) {
            Column(Modifier.width(size * 0.46f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title(hover), style = k.ty.textSmallMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                Text(stateLabel(hover), style = k.ty.textXsmall, color = c.faint, maxLines = 1, textAlign = TextAlign.Center)
            }
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("$decisions", style = k.ty.wheelCount, color = c.fg)
                Text(if (decisions == 1) "decision" else "decisions", style = k.ty.textXsmallMedium, color = c.faint)
            }
        }
    }
}
