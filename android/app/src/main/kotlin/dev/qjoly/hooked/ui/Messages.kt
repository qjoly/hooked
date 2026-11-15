package dev.qjoly.hooked.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.LiveSnapshot
import dev.qjoly.hooked.data.SessionDetail
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.BIG_DIFF
import dev.qjoly.hooked.state.Conversation
import dev.qjoly.hooked.state.LineKind
import dev.qjoly.hooked.state.Queued
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.ToolCall
import dev.qjoly.hooked.state.Turn
import dev.qjoly.hooked.state.TurnPart
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.state.clipLines
import dev.qjoly.hooked.state.diffHunks
import dev.qjoly.hooked.state.diffLineCount
import dev.qjoly.hooked.state.elapsedLabel
import dev.qjoly.hooked.state.firstLine
import dev.qjoly.hooked.state.splitMessageImages
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Kit
import dev.qjoly.hooked.ui.kit.KitColors
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Spinner
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.session.CodeActions
import dev.qjoly.hooked.ui.session.MediaEnv
import dev.qjoly.hooked.ui.session.Picture
import dev.qjoly.hooked.ui.session.RuneMarkdown
import dev.qjoly.hooked.ui.session.SentFiles
import dev.qjoly.hooked.ui.session.ShowWork
import dev.qjoly.hooked.ui.session.copyText

/** rune's Markdown, for screens outside the conversation. */
@Composable
fun MarkdownBody(text: String, modifier: Modifier = Modifier, color: Color = k.c.fg) = RuneMarkdown(text, modifier, color)

// The Converse lens: session.rs `converse`, `bubble` and `tool_chip`, at rune's sizes.

private const val WINDOW = 40
private const val STEP = 120

/** What a bubble needs from the pane around it. */
class ConverseEnv(
    val app: AppModel,
    val model: SessionModel,
    val ui: SessionUi,
    val media: MediaEnv,
    val toolsOpen: SnapshotStateMap<String, Boolean>,
    val ctx: Context,
    val onForkOptions: (String) -> Unit,
) {
    val code = CodeActions(onRun = { model.runCode(it) }, onCopy = {
        copyText(ctx, it)
        app.say("✓ Copied")
    }, onView = { app.openQuerySpec(it) })

    fun forkHere(uuid: String) {
        val s = model.detail?.session
        model.fork(uuid, "", s?.model, s?.effort, null) {
            app.refreshSoon()
            app.open(it)
        }
    }
}

fun bubbleShape(user: Boolean): Shape =
    if (user) RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp) else RoundedCornerShape(14.dp, 14.dp, 14.dp, 4.dp)

/** The kit with its ink swapped for the accent's, for what sits on a user bubble. */
@Composable
fun onAccent(kit: Kit, fill: Color = kit.c.accent): Kit = remember(kit, fill) {
    val ink = kit.c.accentFg
    val raw = kit.c.raw.copy(fg = ink, muted = ink.copy(alpha = 0.85f), faint = ink.copy(alpha = 0.7f), chip = ink.copy(alpha = 0.16f), accent = ink)
    Kit(kit.scheme, KitColors(raw, kit.dark, kit.scheme), kit.r)
}

fun Modifier.dashedBorder(color: Color, radius: Dp = 14.dp) = drawBehind {
    drawRoundRect(
        color = color,
        cornerRadius = CornerRadius(radius.toPx()),
        style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
    )
}

/** Up to 85 % of the chat's width, on the speaker's side. */
@Composable
private fun Lane(user: Boolean, content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        Box(Modifier.fillMaxWidth(0.85f), contentAlignment = if (user) Alignment.TopEnd else Alignment.TopStart) { content() }
    }
}

@Composable
private fun AssistantSkin(modifier: Modifier = Modifier, border: Color? = k.c.border, dashed: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val shape = bubbleShape(false)
    Column(
        modifier.width(IntrinsicSize.Max).clip(shape).background(k.c.surface)
            .then(if (dashed) Modifier.dashedBorder(border ?: k.c.border) else if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

@Composable
private fun Who(user: Boolean, extra: String, ink: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        KIcon(if (user) Lucide.User else Lucide.Bot, ink, 13.dp)
        Text(if (user) "You" else "Claude", style = k.ty.textSmallMedium, color = ink)
        if (extra.isNotEmpty()) Text(extra, style = k.ty.textXsmall, color = ink.copy(alpha = ink.alpha * 0.75f))
    }
}

@Composable
fun ConverseTranscript(env: ConverseEnv, conv: Conversation, d: SessionDetail, modifier: Modifier = Modifier) {
    val model = env.model
    var visible by remember(model.id) { mutableIntStateOf(WINDOW) }
    val turns = conv.turns
    val start = (turns.size - visible).coerceAtLeast(0)
    val shown = turns.subList(start, turns.size)
    val snap = model.snapshot
    val busy = model.isBusy
    val state = rememberLazyListState()
    // The list keeps the item it showed when one lands below it: follow the bottom when the reader was there.
    LaunchedEffect(turns.size, snap?.text?.length, snap?.thinking?.length, busy, model.queued.size, d.pendingLeadIn) {
        if (state.firstVisibleItemIndex <= 1) state.scrollToItem(0)
    }
    LazyColumn(
        modifier.fillMaxSize(),
        state = state,
        reverseLayout = true,
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (busy) item(key = "working") { WorkingLine(model, snap, d) }
        val lead = d.pendingLeadIn?.takeIf { it.isNotBlank() }
        when {
            lead != null -> item(key = "leadin") {
                Lane(false) {
                    AssistantSkin(dashed = true) {
                        Who(false, "live stream", k.c.muted)
                        RuneMarkdown(lead)
                    }
                }
            }
            // A finished turn's text is in the transcript already.
            snap != null && snap.busy && (snap.text.isNotEmpty() || snap.thinking.isNotEmpty()) -> item(key = "streaming") { Streaming(snap) }
        }
        items(model.queued.asReversed(), key = { "q-${it.id}" }) { QueuedBubble(it) }
        items(shown.asReversed(), key = { "m-${it.index}" }) { Bubble(env, it) }
        if (turns.isEmpty() && model.queued.isEmpty()) item(key = "empty") { Text("Empty conversation.", style = k.ty.body, color = k.c.faint) }
        if (start > 0) item(key = "earlier") {
            KButton("Show earlier messages · $start hidden", { visible += STEP }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, icon = Lucide.ArrowUp)
        }
    }
}

@Composable
private fun Streaming(snap: LiveSnapshot) {
    Lane(false) {
        AssistantSkin(border = k.c.accent.copy(alpha = 0.6f)) {
            Who(false, "live", k.c.muted)
            if (snap.thinking.isNotEmpty()) Text(firstLine(snap.thinking, 400), style = k.ty.textSmall, color = k.c.faint)
            if (snap.text.isNotEmpty()) RuneMarkdown(snap.text)
        }
    }
}

@Composable
private fun WorkingLine(model: SessionModel, snap: LiveSnapshot?, d: SessionDetail) {
    val now = rememberNow(1_000)
    val verb = snap?.tool ?: d.session.activity ?: "Working"
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Spinner()
        Text("$verb…", style = k.ty.uiMedium, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        model.workingSince?.let { Text("· ${elapsedLabel(((now - it) / 1000).coerceAtLeast(0))}", style = k.ty.ui, color = k.c.faint) }
    }
}

@Composable
private fun QueuedBubble(q: Queued) {
    val c = k.c
    Lane(true) {
        Column(
            Modifier.width(IntrinsicSize.Max).clip(bubbleShape(true)).background(c.warning.bg)
                .dashedBorder(c.warning.fg).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Who(true, "queued", c.muted)
            Text(q.text, style = k.ty.body, color = c.fg)
        }
    }
}

@Composable
fun Bubble(env: ConverseEnv, m: Turn) {
    val c = k.c
    if (m.role == "system") {
        Text(firstLine(m.text, 160), style = k.ty.textXsmall, color = c.faint, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        return
    }
    val now = env.app.now
    val user = m.user
    val ts = m.ts?.let { agoShort(it, now) }.orEmpty()
    val base = k
    val fill = if (m.auto) c.info.fg else c.accent
    val ck = if (user) onAccent(base, fill) else base
    Lane(user) {
        ProvideKit(ck) {
            val shape = bubbleShape(user)
            Column(
                Modifier.width(IntrinsicSize.Max).clip(shape)
                    .then(if (user) Modifier.background(fill) else Modifier.background(c.surface).border(1.dp, c.border, shape))
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Who(user, if (m.auto) "auto" else ts, k.c.muted)
                    m.forkUuid?.let { uuid ->
                        Spacer(Modifier.weight(1f))
                        KButton("Fork", { env.forkHere(uuid) }, variant = Variant.GHOST_FAINT, size = Size.SMALL, icon = Lucide.Fork)
                        KIconButton(Lucide.ChevronDown, "Fork options", { env.onForkOptions(uuid) }, size = Size.SMALL)
                    }
                }
                val full = m.forkUuid?.let { env.model.fullTexts[it] }
                m.parts.forEach { p ->
                    when (p) {
                        is TurnPart.Text -> if (user) UserText(env, full ?: p.text) else SelectionContainer { RuneMarkdown(p.text, actions = env.code) }
                        is TurnPart.Call -> ToolChip(env, p.tool)
                    }
                }
                if (user && m.truncated && full == null) {
                    m.forkUuid?.let { uuid ->
                        val loading = uuid in env.model.fullTexts
                        KButton(if (loading) "Loading…" else "Show the full message", { env.model.loadFullText(uuid) }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.ChevronDown)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UserText(env: ConverseEnv, text: String) {
    val (images, rest) = remember(text) { splitMessageImages(text) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (images.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                images.forEach { Picture(env.media, it, 220.dp, 160.dp, images, pasted = true) }
            }
        }
        if (rest.isNotEmpty()) SelectionContainer { Text(rest, style = k.ty.body, color = k.c.fg) }
    }
}

@Composable
fun ToolChip(env: ConverseEnv, t: ToolCall) {
    val c = k.c
    val key = t.id ?: "${t.name}:${t.detail}"
    val open = env.ui.allToolsOpen || env.toolsOpen[key] == true
    val changed = remember(t.diff) { t.diff?.let(::diffLineCount) }
    val big = (changed ?: 0) > BIG_DIFF
    val shape = RoundedCornerShape(k.r.md)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, c.border, shape).background(c.surface)) {
        Row(
            Modifier.fillMaxWidth().height(28.dp).clip(RoundedCornerShape(k.r.sm))
                .clickable { env.toolsOpen[key] = !(env.toolsOpen[key] ?: false) }.padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            KIcon(Lucide.Tool, c.faint, 12.dp)
            Text(t.name, style = k.ty.textSmallMedium, color = c.muted, maxLines = 1)
            Text(t.detail.orEmpty(), style = k.ty.mono, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (big) Text("$changed lines", style = k.ty.textXsmall, color = c.faint)
        }
        val qid = t.id
        if (qid != null && t.result != null && dev.qjoly.hooked.state.isQueryTool(t.name)) {
            Row(Modifier.padding(start = 8.dp, end = 8.dp, bottom = 6.dp)) {
                KButton("View the result", { env.app.openQueryResult(env.model.id, qid) }, variant = Variant.OUTLINE, size = Size.SMALL, icon = Lucide.Chart)
            }
        }
        val diff = t.diff
        if (diff != null) {
            if (!big || open) InlineDiff(diff)
        } else if (open) {
            t.inputText?.let { MonoSection("Input", it) }
            t.result?.let { MonoSection("Result", it) }
        }
        t.send?.let { SentFiles(env.media, it) }
        t.show?.let { ShowWork(env.media, it) }
    }
}

@Composable
private fun MonoSection(label: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = k.ty.textXsmallMedium, color = k.c.faint)
        SelectionContainer { Text(remember(body) { clipLines(body, 60) }, style = k.ty.mono, color = k.c.muted) }
    }
}

private const val DIFF_CAP = 400

/** Edit / Write calls as unified hunks with three lines of context, rune's diff colours. */
@Composable
fun InlineDiff(diff: kotlinx.serialization.json.JsonObject) {
    val c = k.c
    val ops = diff["ops"].arr
    Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        var shown = 0
        ops.forEach { op ->
            if (op["all"].bool) Text("replace all occurrences", style = k.ty.textXsmall, color = c.faint)
            val old = if (op["kind"].str == "notebook") "" else op["old"].str.orEmpty()
            val new = if (op["kind"].str == "write") op["content"].str.orEmpty() else op["new"].str.orEmpty()
            val hunks = remember(old, new) { diffHunks(old, new, 3) }
            val shape = RoundedCornerShape(k.r.sm)
            Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, c.border, shape)) {
                hunks.forEachIndexed { hi, h ->
                    if (hi > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(c.border))
                    for (l in h.lines) {
                        if (shown >= DIFF_CAP) break
                        shown++
                        val (sign, fill, ink) = when (l.kind) {
                            LineKind.ADDED -> Triple("+", c.success.bg, c.success.fg)
                            LineKind.REMOVED -> Triple("-", c.danger.bg, c.danger.fg)
                            LineKind.CONTEXT -> Triple(" ", Color.Transparent, c.faint)
                        }
                        Row(Modifier.fillMaxWidth().background(fill).padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(sign, style = k.ty.mono, color = ink, modifier = Modifier.width(10.dp))
                            Text(l.text.ifEmpty { " " }, style = k.ty.mono, color = if (l.kind == LineKind.CONTEXT) c.muted else c.fg, modifier = Modifier.weight(1f))
                        }
                    }
                }
            }
        }
    }
}
