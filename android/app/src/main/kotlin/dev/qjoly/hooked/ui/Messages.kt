package dev.qjoly.hooked.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Compress
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.markdownPadding
import dev.qjoly.hooked.data.LiveSnapshot
import dev.qjoly.hooked.data.Message
import dev.qjoly.hooked.data.MessagePart
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.data.Tool
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.shortAge
import dev.qjoly.hooked.data.str
import kotlinx.serialization.json.Json

/** Readable line length on a wide tablet. */
val ConversationWidth = 920.dp

@Composable
fun MarkdownBody(text: String, modifier: Modifier = Modifier, color: Color = hooked.ink) {
    val t = MaterialTheme.typography
    val body = t.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp, color = color)
    Markdown(
        content = text,
        colors = markdownColor(text = color, codeBackground = hooked.panel, inlineCodeBackground = hooked.panel, dividerColor = hooked.line),
        typography = markdownTypography(
            h1 = t.titleLarge.copy(color = color), h2 = t.titleLarge.copy(fontSize = 19.sp, color = color),
            h3 = t.titleMedium.copy(fontSize = 17.sp, color = color), h4 = t.titleMedium.copy(color = color),
            h5 = t.titleSmall.copy(color = color), h6 = t.titleSmall.copy(color = color),
            text = body, paragraph = body, ordered = body, bullet = body, list = body, table = body.copy(fontSize = 14.sp),
            code = body.copy(fontFamily = Mono, fontSize = 13.sp, lineHeight = 19.sp),
            inlineCode = body.copy(fontFamily = Mono, fontSize = 13.5.sp),
            quote = body.copy(fontStyle = FontStyle.Italic, color = hooked.muted),
        ),
        padding = markdownPadding(block = 3.dp),
        modifier = modifier.fillMaxWidth(),
    )
}

@Composable
fun CodeBlock(text: String, maxLines: Int = Int.MAX_VALUE) {
    Box(
        Modifier.fillMaxWidth().background(hooked.code, RoundedCornerShape(10.dp)).horizontalScroll(rememberScrollState()).padding(10.dp),
    ) {
        Text(text, fontFamily = Mono, fontSize = 12.sp, lineHeight = 17.sp, color = hooked.codeFg, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun MessageRow(message: Message, now: Long) {
    when {
        message.role == "user" && !message.auto -> UserBubble(message.text, message.ts, now, truncated = message.truncated)
        message.role == "assistant" -> AssistantCard(message.renderParts, message.ts, now, message.truncated)
        else -> SystemLine(if (message.auto) "Automatic wake-up" else message.text, compact = message.kind == "compact")
    }
}

@Composable
private fun Meta(icon: ImageVector, who: String, ts: Long?, now: Long, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, Modifier.size(15.dp), tint = color)
        Text(who, style = MaterialTheme.typography.labelLarge, color = color)
        if (ts != null) Text(shortAge(ts, now).let { if (it == "now") "just now" else "$it ago" }, fontSize = 12.sp, color = color.copy(alpha = 0.7f))
    }
}

@Composable
fun UserBubble(text: String, ts: Long?, now: Long, queued: Boolean = false, truncated: Boolean = false) {
    val waiting = stateStyle(SessionState.WAITING)
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        val shape = RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp)
        Column(
            Modifier.padding(start = 64.dp).widthIn(max = 720.dp)
                .background(if (queued) waiting.soft else hooked.userBubble, shape)
                .then(if (queued) Modifier.border(1.dp, waiting.hue, shape) else Modifier)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            horizontalAlignment = Alignment.End,
        ) {
            val fg = if (queued) hooked.ink else hooked.userText
            Meta(Icons.Outlined.Person, "You", ts, now, fg.copy(alpha = 0.85f))
            SelectionContainer { Text(text, color = fg, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp)) }
            if (truncated) TruncatedNote(fg.copy(alpha = 0.7f))
            if (queued) Text("Sending…", color = waiting.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
fun AssistantCard(parts: List<MessagePart>, ts: Long?, now: Long, truncated: Boolean = false) {
    Surface(
        Modifier.padding(end = 40.dp).fillMaxWidth(),
        shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 6.dp),
        color = hooked.card,
        border = BorderStroke(0.5.dp, hooked.line),
        shadowElevation = 1.dp,
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Meta(Icons.Outlined.SmartToy, "Claude", ts, now, hooked.ink)
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    parts.forEach { part ->
                        when (part) {
                            is MessagePart.Text -> MarkdownBody(part.text)
                            is MessagePart.ToolUse -> ToolChip(part.tool)
                        }
                    }
                }
            }
            if (truncated) TruncatedNote(hooked.muted)
        }
    }
}

@Composable
private fun TruncatedNote(color: Color) {
    Text("Message truncated: open it in the web dashboard for the full text.", fontSize = 11.sp, color = color)
}

@Composable
fun SystemLine(text: String, compact: Boolean = false) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (compact) Icon(Icons.Outlined.Compress, null, Modifier.size(14.dp).padding(end = 2.dp), tint = hooked.muted)
        Text(text, fontSize = 12.sp, color = hooked.muted, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

private const val RESULT_CAP = 3000

@Composable
fun ToolChip(tool: Tool) {
    var open by rememberSaveable(tool.id) { mutableStateOf(false) }
    val diff = remember(tool) { diffOf(tool) }
    Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier.clip(RoundedCornerShape(10.dp)).background(hooked.crema).clickable { open = !open }.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Icon(Icons.Outlined.Build, null, Modifier.size(14.dp), tint = hooked.ink)
            Text(tool.name, fontFamily = Mono, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, color = hooked.ink)
            tool.detail?.let {
                Text(it, fontFamily = Mono, fontSize = 12.5.sp, color = hooked.muted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f, fill = false))
            }
            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp).rotate(if (open) 90f else 0f), tint = hooked.muted)
        }
        if (diff != null) DiffView(diff)
        if (open) {
            tool.inputText?.takeIf { diff == null }?.let { ToolSection("Input", it) }
            tool.result?.let { ToolSection("Result", it) }
            if (tool.inputText == null && tool.result == null) Text("No details", fontSize = 11.sp, color = hooked.muted)
        }
    }
}

@Composable
private fun ToolSection(title: String, body: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(title.uppercase(), fontSize = 10.sp, fontWeight = FontWeight.Bold, color = hooked.muted, letterSpacing = 0.6.sp)
        CodeBlock(if (body.length > RESULT_CAP) body.take(RESULT_CAP) + "\n…" else body, maxLines = 40)
    }
}

/** A line of an Edit or Write call: '-' removed, '+' added. */
data class DiffLine(val sign: Char, val text: String)

/** The change an Edit, MultiEdit or Write call makes, read from its input. */
fun diffOf(tool: Tool): List<DiffLine>? {
    if (tool.name !in setOf("Edit", "MultiEdit", "Write")) return null
    val input = runCatching { Json.parseToJsonElement(tool.inputText ?: return null) }.getOrNull() ?: return null
    fun lines(sign: Char, s: String?) = s?.split('\n')?.map { DiffLine(sign, it) }.orEmpty()
    return when (tool.name) {
        "Write" -> lines('+', input["content"].str)
        "Edit" -> lines('-', input["old_string"].str) + lines('+', input["new_string"].str)
        else -> input["edits"].arr.flatMapIndexed { i, e ->
            (if (i > 0) listOf(DiffLine(' ', "…")) else emptyList()) + lines('-', e["old_string"].str) + lines('+', e["new_string"].str)
        }
    }.takeIf { it.isNotEmpty() }
}

private const val DIFF_PREVIEW = 14

@Composable
private fun DiffView(lines: List<DiffLine>) {
    var all by remember { mutableStateOf(false) }
    val shown = if (all) lines else lines.take(DIFF_PREVIEW)
    val dark = hooked.dark
    val added = if (dark) Color(0xFF1F3A26) else Color(0xFFE3F3E6)
    val removed = if (dark) Color(0xFF4A2023) else Color(0xFFFBE3E3)
    val addedBar = Color(0xFF418D50)
    val removedBar = Color(0xFFC43D4D)
    BoxWithConstraints(Modifier.fillMaxWidth().background(hooked.panel, RoundedCornerShape(10.dp)).padding(vertical = 6.dp)) {
      val full = maxWidth
      Column {
        // Rows as wide as the longest line, and never narrower than the card, so the tint spans the line.
        Column(Modifier.horizontalScroll(rememberScrollState()).width(IntrinsicSize.Max).widthIn(min = full)) {
            shown.forEach { l ->
                Row(Modifier.fillMaxWidth().background(if (l.sign == '+') added else if (l.sign == '-') removed else Color.Transparent)) {
                    Box(Modifier.size(3.dp, 19.dp).background(if (l.sign == '+') addedBar else if (l.sign == '-') removedBar else Color.Transparent))
                    Text(
                        "${if (l.sign == ' ') ' ' else l.sign} ${l.text}",
                        fontFamily = Mono, fontSize = 12.sp, lineHeight = 19.sp, color = hooked.ink, softWrap = false,
                        modifier = Modifier.padding(horizontal = 10.dp),
                    )
                }
            }
        }
        if (lines.size > DIFF_PREVIEW) {
            TextButton(onClick = { all = !all }, modifier = Modifier.padding(start = 4.dp)) {
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp).rotate(if (all) 180f else 0f))
                Spacer(Modifier.width(4.dp))
                Text(if (all) "Show less" else "Show ${lines.size - DIFF_PREVIEW} more lines", fontSize = 12.sp)
            }
        }
      }
    }
}

/** The turn in progress, fed by /api/session/stream. */
@Composable
fun LiveBubble(snapshot: LiveSnapshot) {
    val working = stateStyle(SessionState.WORKING)
    val shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 6.dp)
    Column(
        Modifier.padding(end = 40.dp).fillMaxWidth()
            .background(hooked.card, shape)
            .dashedBorder(working.hue.copy(alpha = 0.6f), 18.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when {
            snapshot.text.isNotEmpty() -> MarkdownBody(snapshot.text)
            snapshot.thinking.isNotEmpty() -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.AutoMirrored.Outlined.Notes, null, Modifier.size(15.dp), tint = hooked.muted)
                Text(snapshot.thinking.takeLast(400), fontSize = 13.sp, fontStyle = FontStyle.Italic, color = hooked.muted, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            StateDot(working)
            val label = snapshot.activity ?: snapshot.tool ?: if (snapshot.text.isEmpty() && snapshot.thinking.isNotEmpty()) "Thinking…" else "Working…"
            Text(label, fontSize = 12.sp, color = working.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

fun Modifier.dashedBorder(color: Color, radius: Dp) = drawBehind {
    drawRoundRect(
        color = color,
        cornerRadius = CornerRadius(radius.toPx()),
        style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 6f))),
    )
}
