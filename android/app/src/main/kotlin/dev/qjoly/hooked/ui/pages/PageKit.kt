package dev.qjoly.hooked.ui.pages

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.qjoly.hooked.data.Bar
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.LinkTarget
import dev.qjoly.hooked.data.linkTarget
import dev.qjoly.hooked.data.pctLabel
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.MarkdownBody
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Spinner
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

// Shared pieces of rune's pages (view/pages.rs and the rune-kit controls they use).

/** A page's state, kept across tab switches like rune's `PageData`. */
abstract class PageModel : ViewModel() {
    /** Runs a server call; a failure lands in the flash as "✗ <failure>: <error>". */
    protected fun call(app: AppModel, failure: String, block: suspend (HookedClient) -> Unit): Job? {
        val c = app.client ?: return null
        return viewModelScope.launch {
            try {
                block(c)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.say("✗ $failure: ${e.message}")
            }
        }
    }
}

/** rune's `page`: a 48 bar (title left, actions right, bottom rule) over the body. */
@Composable
fun PageFrame(title: String, actions: @Composable RowScope.() -> Unit = {}, body: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().height(48.dp).bottomRule(k.c.border).padding(horizontal = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, style = k.ty.bodyMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(1f))
            actions()
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { body() }
    }
}

@Composable
fun PageLoading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner() }
}

fun Modifier.bottomRule(color: Color) = drawBehind {
    drawLine(color, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx())
}

fun Modifier.endRule(color: Color) = drawBehind {
    drawLine(color, Offset(size.width - 0.5f, 0f), Offset(size.width - 0.5f, size.height), 1.dp.toPx())
}

/** A list column on the left of a split page: fixed width and a rule on its right. */
fun Modifier.sideList(width: Dp, color: Color) = width(width).fillMaxHeight().endRule(color)

/** rune-kit's SegmentedControl in `fit` mode: equal cells as wide as the widest label, a sliding raised indicator. */
@Composable
fun PageSegmented(labels: List<String>, selected: Int?, onPick: (Int) -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(6.dp)
    val style = k.ty.ui.copy(lineHeight = 13.sp)
    val x by animateFloatAsState((selected ?: 0).toFloat(), label = "segment")
    val indicator = k.c.bg
    val edge = k.c.border2
    Layout(
        content = {
            Box(Modifier.clip(shape).background(indicator).border(0.5.dp, edge, shape))
            labels.forEachIndexed { i, l ->
                Box(
                    Modifier.clip(shape).clickable(remember { MutableInteractionSource() }, indication = null) { onPick(i) }.padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center,
                ) { Text(l, style = style, color = if (i == selected) k.c.fg else k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        },
        modifier = modifier.height(28.dp).clip(shape).background(k.c.surface).border(0.5.dp, k.c.border, shape),
    ) { measurables, constraints ->
        val h = 28.dp.roundToPx()
        val cells = measurables.drop(1)
        val n = cells.size.coerceAtLeast(1)
        val widest = cells.maxOfOrNull { it.maxIntrinsicWidth(h) } ?: 0
        val w = if (constraints.hasBoundedWidth) minOf(widest, constraints.maxWidth / n) else widest
        val placed = cells.map { it.measure(Constraints.fixed(w, h)) }
        val ind = measurables[0].measure(Constraints.fixed(w, h))
        layout(w * n, h) {
            if (selected != null) ind.place((x * w).roundToInt(), 0)
            placed.forEachIndexed { i, p -> p.place(i * w, 0) }
        }
    }
}

/** rune-kit's compact Switch (Mini, 36 × 16): faint small label, then the track. */
@Composable
fun PageSwitch(checked: Boolean, onToggle: () -> Unit, label: String? = null, modifier: Modifier = Modifier) {
    val knobX by animateDpAsState(if (checked) 14.dp else 1.dp, label = "knob")
    Row(
        modifier.clickable(remember { MutableInteractionSource() }, indication = null, onClick = onToggle).heightIn(min = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        label?.let { Text(it, style = k.ty.small.copy(lineHeight = 16.sp), color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)) }
        Box(Modifier.size(36.dp, 16.dp).clip(RoundedCornerShape(8.dp)).background(if (checked) k.c.accent else k.c.border2)) {
            val knob = RoundedCornerShape(7.dp)
            Box(Modifier.offset(knobX, 1.dp).size(21.dp, 14.dp).shadow(1.dp, knob, ambientColor = k.c.shadow, spotColor = k.c.shadow).clip(knob).background(Color.White))
        }
    }
}

/** Settings' filter chip: h 26, raised and focus-bordered when on. */
@Composable
fun PageChip(label: String, on: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(k.r.sm)
    Box(
        Modifier.height(26.dp).clip(shape).background(if (on) k.c.chip else Color.Transparent).border(1.dp, if (on) k.c.accent else k.c.border, shape)
            .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClick).padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = k.ty.textSmallMedium, color = if (on) k.c.fg else k.c.muted, maxLines = 1) }
}

/** rune's `card`: padding 16, gap 8, section title on top. */
@Composable
fun PageCard(title: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(k.r.lg)
    Column(
        modifier.clip(shape).background(k.c.surface).border(1.dp, k.c.border, shape).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SectionTitle(title)
        content()
    }
}

/** A bordered surface box with `pad` and `gap`, the shape most page rows take. */
@Composable
fun PageBox(modifier: Modifier = Modifier, pad: Dp = 12.dp, gap: Dp = 6.dp, radius: Dp = k.r.md, border: Color = k.c.border, fill: Color = k.c.surface, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(radius)
    Column(
        modifier.fillMaxWidth().clip(shape).background(fill).border(1.dp, border, shape).padding(pad),
        verticalArrangement = Arrangement.spacedBy(gap),
        content = content,
    )
}

/** rune's `hbar`: label 220, a track that fills to `frac`, the value 80 on the right. */
@Composable
fun HBar(bar: Bar, value: String, color: Color) {
    Row(Modifier.fillMaxWidth().height(24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(bar.label, style = k.ty.textSmall, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(220.dp))
        Box(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(3.dp)).background(k.c.chip)) {
            Box(Modifier.fillMaxWidth(bar.frac).fillMaxHeight().clip(RoundedCornerShape(3.dp)).background(color))
        }
        Text(value, style = k.ty.textSmall, color = k.c.faint, maxLines = 1, modifier = Modifier.width(80.dp))
    }
}

/** rune's `usage_bar`: label and percentage, a 6 track coloured by threshold, a faint caption. */
@Composable
fun UsageBar(label: String, pct: Double?, sub: String) {
    val p = (pct ?: 0.0).coerceIn(0.0, 100.0).toFloat()
    val fill = when {
        p >= 90f -> k.c.danger.icon
        p >= 75f -> k.c.warning.icon
        else -> k.c.accent
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(label, style = k.ty.textSmall, color = k.c.muted)
            Spacer(Modifier.weight(1f))
            Text(pctLabel(pct), style = k.ty.textSmallMedium, color = k.c.fg)
        }
        Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(k.c.chip)) {
            Box(Modifier.fillMaxWidth(p / 100f).fillMaxHeight().clip(RoundedCornerShape(3.dp)).background(fill))
        }
        Text(sub, style = k.ty.textXsmall, color = k.c.faint)
    }
}

/** A form field: a section title over its input. */
@Composable
fun PageField(label: String, modifier: Modifier = Modifier, input: @Composable () -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionTitle(label)
        input()
    }
}

/** rune-kit's TextArea with `auto_grow(min, max)`: top-aligned text that grows by lines, then scrolls. */
@Composable
fun PageTextArea(value: String, onValueChange: (String) -> Unit, placeholder: String = "", minRows: Int = 3, maxRows: Int = 12, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(k.r.md)
    val style = k.ty.ui
    val line = 20.dp
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        textStyle = style.copy(color = k.c.fg),
        cursorBrush = SolidColor(k.c.accent),
        minLines = minRows,
        maxLines = maxRows,
        modifier = modifier.fillMaxWidth().heightIn(min = line * minRows + 12.dp, max = line * maxRows + 12.dp),
        decorationBox = { inner ->
            Box(Modifier.clip(shape).background(k.c.bg).border(1.dp, k.c.border, shape).padding(horizontal = 8.dp, vertical = 6.dp)) {
                if (value.isEmpty()) Text(placeholder, style = style, color = k.c.faint)
                inner()
            }
        },
    )
}

/** Markdown whose links behave as rune's `open_link`: `/session/<id>` opens the session in the app. */
@Composable
fun PageMarkdown(app: AppModel, text: String, modifier: Modifier = Modifier, selectable: Boolean = false) {
    val platform = LocalUriHandler.current
    val base = app.config?.base.orEmpty()
    val handler = remember(platform, base) {
        object : UriHandler {
            override fun openUri(uri: String) {
                when (val t = linkTarget(uri, base)) {
                    is LinkTarget.Session -> app.open(t.id)
                    is LinkTarget.Open -> runCatching { platform.openUri(t.url) }.onFailure { app.say("✗ Could not open ${t.url}") }
                }
            }
        }
    }
    CompositionLocalProvider(LocalUriHandler provides handler) {
        if (selectable) SelectionContainer { MarkdownBody(text, modifier) } else MarkdownBody(text, modifier)
    }
}

/** A centred column capped at `max`, as rune's `max_w(…).self_center()`. */
@Composable
fun Centered(max: Dp, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Box(modifier.widthIn(max = max).fillMaxWidth()) { content() }
    }
}
