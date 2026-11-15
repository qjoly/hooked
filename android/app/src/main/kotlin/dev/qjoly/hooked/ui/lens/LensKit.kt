package dev.qjoly.hooked.ui.lens

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.lens.REVIEWED_PER_FILE
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.pages.bottomRule
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.cbrt
import kotlin.math.pow

// Pieces the three lenses share (view/lenses.rs `bar` and `empty`), plus their persisted prefs.

/** rune's lens bar: h 44, px 16, gap 10, a bottom rule. Scrolls sideways when it outgrows a tablet. */
@Composable
fun LensBar(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(
        modifier.fillMaxWidth().height(44.dp).bottomRule(k.c.border).horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

/** A 1 rule on the left edge, as rune's `border_sides([0, 0, 0, 1])`. */
fun Modifier.startRule(color: Color) = drawBehind { drawLine(color, Offset(0.5f, 0f), Offset(0.5f, size.height), 1.dp.toPx()) }

/** A centred faint message filling the lens body. */
@Composable
fun ColumnScope.LensEmpty(msg: String) {
    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
        Text(msg, style = k.ty.body, color = k.c.faint, textAlign = TextAlign.Center)
    }
}

/** A grip on a right-hand column's left edge: dragging left widens the column. */
@Composable
fun ColumnGrip(width: Dp, min: Dp, max: Dp, onWidth: (Dp) -> Unit, onDone: () -> Unit) {
    val density = LocalDensity.current
    val state = rememberDraggableState { px ->
        val next = (width - with(density) { px.toDp() }).coerceIn(min, maxOf(min, max))
        onWidth(next)
    }
    Box(
        Modifier.width(8.dp).fillMaxHeight().draggable(state, Orientation.Horizontal, onDragStopped = { onDone() }),
        contentAlignment = Alignment.Center,
    ) { Box(Modifier.width(1.dp).fillMaxHeight().background(k.c.border)) }
}

// rune-kit's palette `tint`: a fraction of the way from `base` toward `hue` in OKLab, at `base`'s alpha.

private fun lin(c: Float) = if (c <= 0.04045f) c / 12.92f else ((c + 0.055f) / 1.055f).toDouble().pow(2.4).toFloat()
private fun gam(c: Float) = if (c <= 0.0031308f) 12.92f * c else (1.055 * c.toDouble().pow(1 / 2.4) - 0.055).toFloat()

private fun Color.oklab(): FloatArray {
    val r = lin(red)
    val g = lin(green)
    val b = lin(blue)
    val l = cbrt(0.4122214708f * r + 0.5363325363f * g + 0.0514459929f * b)
    val m = cbrt(0.2119034982f * r + 0.6806995451f * g + 0.1073969566f * b)
    val s = cbrt(0.0883024619f * r + 0.2817188376f * g + 0.6299787005f * b)
    return floatArrayOf(
        0.2104542553f * l + 0.7936177850f * m - 0.0040720468f * s,
        1.9779984951f * l - 2.4285922050f * m + 0.4505937099f * s,
        0.0259040371f * l + 0.7827717662f * m - 0.8086757660f * s,
    )
}

private fun fromOklab(L: Float, a: Float, b: Float, alpha: Float): Color {
    val l = (L + 0.3963377774f * a + 0.2158037573f * b).let { it * it * it }
    val m = (L - 0.1055613458f * a - 0.0638541728f * b).let { it * it * it }
    val s = (L - 0.0894841775f * a - 1.2914855480f * b).let { it * it * it }
    val r = 4.0767416621f * l - 3.3077115913f * m + 0.2309699292f * s
    val g = -1.2684380046f * l + 2.6097574011f * m - 0.3413193965f * s
    val bl = -0.0041960863f * l - 0.7034186147f * m + 1.7076147010f * s
    return Color(gam(r).coerceIn(0f, 1f), gam(g).coerceIn(0f, 1f), gam(bl).coerceIn(0f, 1f), alpha)
}

fun tint(base: Color, hue: Color, t: Float): Color {
    val a = base.oklab()
    val b = hue.oklab()
    return fromOklab(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, base.alpha)
}

/** The lenses' own prefs, as rune keeps them in its prefs file: diff layout, rendered width, reviewed ticks. */
class LensPrefs(context: Context) {
    private val sp = context.getSharedPreferences("hooked-lens", Context.MODE_PRIVATE)

    var diffSplit: Boolean
        get() = sp.getBoolean("diffSplit", false)
        set(v) = sp.edit().putBoolean("diffSplit", v).apply()

    var renderedW: Float
        get() = sp.getFloat("renderedW", 460f)
        set(v) = sp.edit().putFloat("renderedW", v).apply()

    /** `session|path` → the fingerprints ticked reviewed, newest last. */
    fun reviewed(): Map<String, List<String>> = runCatching {
        Json.parseToJsonElement(sp.getString("reviewed", "{}") ?: "{}").jsonObject.mapValues { (_, v) -> v.jsonArray.map { it.jsonPrimitive.content } }
    }.getOrDefault(emptyMap())

    fun setReviewed(all: Map<String, List<String>>) {
        val j = JsonObject(all.mapValues { (_, v) -> JsonArray(v.takeLast(REVIEWED_PER_FILE).map(::JsonPrimitive)) })
        sp.edit().putString("reviewed", j.toString()).apply()
    }
}
