package dev.qjoly.hooked.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.markdownPadding
import dev.qjoly.hooked.data.dock.LinkTarget
import dev.qjoly.hooked.data.dock.linkTarget
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.delay

/** Fill and ink of a badge tone, as `ghdetail.rs::badge` maps them. */
@Composable
internal fun toneColors(tone: String): Pair<Color, Color> {
    val c = k.c
    return when (tone) {
        "open", "ok" -> c.success.fg to c.success.bg
        "merged" -> c.info.fg to c.info.bg
        "closed", "ko" -> c.danger.fg to c.danger.bg
        "wait" -> c.warning.fg to c.warning.bg
        else -> c.muted to c.chip
    }
}

@Composable
internal fun Badge(label: String, tone: String) {
    val (fg, bg) = toneColors(tone)
    Pill(label, fg, bg)
}

internal fun Modifier.topRule(color: Color, width: Dp = 1.dp) = drawBehind {
    drawLine(color, Offset(0f, 0f), Offset(size.width, 0f), width.toPx())
}

internal fun Modifier.bottomRule(color: Color, width: Dp = 1.dp) = drawBehind {
    val y = size.height - width.toPx() / 2
    drawLine(color, Offset(0f, y), Offset(size.width, y), width.toPx())
}

internal fun Modifier.leftRule(color: Color, width: Dp = 1.dp) = drawBehind {
    drawLine(color, Offset(0f, 0f), Offset(0f, size.height), width.toPx())
}

/** Opens a link the way rune's `open_link` does: sessions here, Actions runs in the run window, the rest outside. */
internal fun openLink(app: AppModel, dock: DockModel, uri: UriHandler, session: String, url: String) {
    val base = app.client?.config?.base ?: ""
    when (val t = linkTarget(url, base)) {
        is LinkTarget.Session -> app.open(t.id)
        is LinkTarget.Run -> dock.openRun(session, t.url)
        is LinkTarget.Open -> if (runCatching { uri.openUri(t.url) }.isFailure) app.say("✗ Could not open ${t.url}")
    }
}

/** Below the anchor, or above it when there is no room, kept inside the window. */
private object BelowAnchor : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val x = anchorBounds.left.coerceAtMost(windowSize.width - popupContentSize.width).coerceAtLeast(0)
        val below = anchorBounds.bottom + 8
        val y = if (below + popupContentSize.height > windowSize.height) anchorBounds.top - popupContentSize.height - 8 else below
        return IntOffset(x, y.coerceAtLeast(0))
    }
}

/** rune's `.help()` tooltip, shown on long press on a tablet; it fades after a few seconds. */
@Composable
internal fun Hint(text: String?, onDismiss: () -> Unit) {
    if (text == null) return
    LaunchedEffect(text) {
        delay(4_000)
        onDismiss()
    }
    Popup(popupPositionProvider = BelowAnchor, onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        val shape = RoundedCornerShape(k.r.sm)
        Box(
            Modifier.widthIn(max = 420.dp).shadow(4.dp, shape, ambientColor = k.c.shadow, spotColor = k.c.shadow)
                .clip(shape).background(k.c.surface).border(1.dp, k.c.border, shape).padding(horizontal = 8.dp, vertical = 4.dp),
        ) { Text(text, style = k.ty.textXsmall, color = k.c.fg) }
    }
}

/** rune-kit's SegmentedControl in `fit` mode: equal cells as wide as the widest label, the picked one raised. */
@Composable
internal fun Segmented(labels: List<String>, selected: Int, onPick: (Int) -> Unit) {
    val c = k.c
    val shape = RoundedCornerShape(6.dp)
    Row(
        Modifier.width(IntrinsicSize.Max).height(28.dp).clip(shape).background(c.surface).border(0.5.dp, c.border, shape),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Pressable(
                { onPick(i) },
                Modifier.weight(1f).height(28.dp).then(if (on) Modifier.border(0.5.dp, c.border2, shape) else Modifier),
                fill = if (on) c.bg else Color.Transparent,
                radius = 6.dp,
            ) {
                Row(Modifier.weight(1f).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.Center) {
                    Text(label, style = k.ty.ui.copy(lineHeight = k.ty.ui.fontSize), color = if (on) c.fg else c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** rune's `md(...)` in kit colours and the markdown text style (14 / 22.4). */
@Composable
internal fun DockMarkdown(text: String, modifier: Modifier = Modifier) {
    val c = k.c
    val body = k.ty.markdown.copy(color = c.fg)
    val code = k.ty.mono.copy(color = c.fg)
    Markdown(
        content = text,
        colors = markdownColor(text = c.fg, codeBackground = c.chip, inlineCodeBackground = c.chip, dividerColor = c.border),
        typography = markdownTypography(
            h1 = k.ty.h1.copy(color = c.fg), h2 = k.ty.h2.copy(color = c.fg), h3 = k.ty.h3.copy(color = c.fg),
            h4 = k.ty.h3.copy(color = c.fg), h5 = k.ty.h3.copy(color = c.fg), h6 = k.ty.h3.copy(color = c.fg),
            text = body, paragraph = body, ordered = body, bullet = body, list = body, table = body.copy(fontSize = k.ty.textSmall.fontSize),
            code = code, inlineCode = code,
            quote = body.copy(color = c.muted),
        ),
        padding = markdownPadding(block = 3.dp),
        modifier = modifier.fillMaxWidth(),
    )
}
