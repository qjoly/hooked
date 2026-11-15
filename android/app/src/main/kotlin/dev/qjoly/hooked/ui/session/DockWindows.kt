package dev.qjoly.hooked.ui.session

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dock.agoShort
import dev.qjoly.hooked.data.dock.checkState
import dev.qjoly.hooked.data.dock.screenshotUrl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.data.Message
import dev.qjoly.hooked.data.MessagePart
import dev.qjoly.hooked.ui.MarkdownBody
import dev.qjoly.hooked.ui.bubbleShape
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlin.math.abs

/** The windows the dock opens; only the dock of the session that opened one draws it. */
@Composable
internal fun DockOverlays(app: AppModel, dock: DockModel, session: String) {
    dock.ghView?.takeIf { it.session == session }?.let { v ->
        val links = dock.data[session]?.links?.takeIf { v.url in it } ?: listOf(v.url)
        GhFullSheet(app, dock, session, v, links, app.settings["featureFlags"]["dockActions"].bool)
    }
    dock.run?.takeIf { it.owner == session }?.let { RunWindow(app, dock, it) }
    dock.image?.takeIf { it.session == session }?.let { ImageWindow(app, dock, it) }
    dock.agent?.takeIf { it.session == session }?.let { AgentWindow(app, dock, it) }
}

/** A centred panel over a scrim: radius lg, page fill, 1 border, overlay shadow. */
@Composable
private fun Floating(onDismiss: () -> Unit, width: Dp, heightFrac: Float, content: @Composable ColumnScope.() -> Unit) {
    val kit = k
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        ProvideKit(kit) {
            BoxWithConstraints(
                Modifier.fillMaxSize().background(k.c.scrim).clickable(remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
                contentAlignment = Alignment.TopCenter,
            ) {
                val shape = RoundedCornerShape(k.r.lg)
                Column(
                    Modifier.padding(top = 60.dp).width(width.coerceAtMost(maxWidth - 32.dp)).height(maxHeight * heightFrac)
                        .shadow(16.dp, shape, ambientColor = k.c.shadow, spotColor = k.c.shadow)
                        .clip(shape).background(k.c.bg).border(1.dp, k.c.border, shape)
                        .clickable(remember { MutableInteractionSource() }, indication = null) {},
                ) { content() }
            }
        }
    }
}

/** `view/ghrun.rs`: a GitHub Actions run, its jobs, the picked job's steps and log. */
@Composable
private fun RunWindow(app: AppModel, dock: DockModel, w: RunWin) {
    val c = k.c
    val uri = LocalUriHandler.current
    val run = w.run
    val url = run?.url?.takeIf { it.isNotEmpty() } ?: w.url
    Floating({ dock.closeRun() }, 980.dp, 0.8f) {
        Row(
            Modifier.fillMaxWidth().height(40.dp).bottomRule(c.border).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Dot(c.stateColor(checkState(run?.status.orEmpty())), 8.dp)
            Text(run?.let { "${it.workflow} · ${it.title}" } ?: "GitHub Actions run", style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            KButton("GitHub", { runCatching { uri.openUri(url) } }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Github)
            KButton("Close", { dock.closeRun() }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
        }
        w.err?.let { Text(it, style = k.ty.textSmall, color = c.danger.fg, modifier = Modifier.padding(12.dp)) }
        when {
            run != null -> {
                Text(
                    "${run.branch} · ${run.event} · attempt ${run.attempt} · ${agoShort(run.updatedAt, app.now)} ago",
                    style = k.ty.textXsmall, color = c.faint, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
                val job = run.job(w.job)
                Row(Modifier.fillMaxWidth().weight(1f).padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.width(220.dp).fillMaxHeight().verticalScroll(rememberScrollState()).padding(horizontal = 6.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        for (j in run.jobs) {
                            val on = j.id == job?.id
                            Pressable({ dock.pickRunJob(j.id) }, Modifier.fillMaxWidth().height(28.dp), fill = if (on) c.chip else Color.Transparent, radius = k.r.sm) {
                                Row(Modifier.weight(1f).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Dot(c.stateColor(checkState(j.status)), 7.dp)
                                    Text(j.name, style = k.ty.textSmall, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                    Text(j.duration, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                                }
                            }
                        }
                    }
                    Column(Modifier.weight(1f).fillMaxHeight().padding(end = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (job != null) {
                            SectionTitle("STEPS")
                            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                for (st in job.steps) {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Dot(c.stateColor(checkState(st.status)), 6.dp)
                                        Text(st.name, style = k.ty.textSmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                        Text(st.duration, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                                    }
                                }
                            }
                            SectionTitle("LOG")
                            RunLog(w.log?.takeIf { it.first == job.id }?.second, Modifier.weight(1f))
                        }
                    }
                }
            }
            w.err == null -> Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                KIcon(Lucide.Clock, c.faint, 12.dp)
                Text("Loading the run…", style = k.ty.textSmall, color = c.faint)
            }
        }
    }
}

private const val RUN_LOG_LINES = 3000

@Composable
private fun RunLog(log: Result<String?>?, modifier: Modifier) {
    val c = k.c
    val lines = remember(log) { log?.getOrNull()?.lines()?.takeLast(RUN_LOG_LINES).orEmpty() }
    Box(modifier.fillMaxWidth().clip(RoundedCornerShape(k.r.sm)).background(c.chip)) {
        val err = log?.exceptionOrNull()
        when {
            log == null -> Text("Loading the log…", style = k.ty.textSmall, color = c.faint, modifier = Modifier.padding(8.dp))
            err != null -> Text(err.message ?: "Could not load the log", style = k.ty.textSmall, color = c.danger.fg, modifier = Modifier.padding(8.dp))
            log.getOrNull() == null -> Text("No log until the job finishes.", style = k.ty.textSmall, color = c.faint, modifier = Modifier.padding(8.dp))
            else -> {
                val state = remember(log) { androidx.compose.foundation.lazy.LazyListState() }
                LaunchedEffect(lines.size) { if (lines.isNotEmpty()) state.scrollToItem(lines.size - 1) }
                SelectionContainer {
                    LazyColumn(Modifier.fillMaxSize(), state, contentPadding = PaddingValues(8.dp)) {
                        items(lines) { l -> Text(l, style = k.ty.mono, color = if ("##[error]" in l) c.danger.fg else c.muted) }
                    }
                }
            }
        }
    }
}

/** rune's lightbox: name, position, open outside, close; swipe or the arrows step through. */
@Composable
private fun ImageWindow(app: AppModel, dock: DockModel, v: ImageViewer) {
    val path = v.paths.getOrNull(v.index) ?: return
    val kit = k
    val uri = LocalUriHandler.current
    val img = dock.full?.takeIf { it.first == path }?.second
    Dialog({ dock.closeImage() }, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        ProvideKit(kit) {
            val c = k.c
            BoxWithConstraints(
                Modifier.fillMaxSize().background(c.scrim).clickable(remember { MutableInteractionSource() }, indication = null) { dock.closeImage() },
                contentAlignment = Alignment.TopCenter,
            ) {
                val maxW = minOf(1280.dp, maxWidth - 32.dp)
                val maxH = (maxHeight - 140.dp).coerceAtLeast(200.dp)
                Column(Modifier.padding(top = 30.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        Modifier.clip(RoundedCornerShape(k.r.md)).background(c.bg).clickable(remember { MutableInteractionSource() }, indication = null) {}.padding(8.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(path.substringAfterLast('/'), style = k.ty.uiMedium, color = c.fg, maxLines = 1)
                        if (v.paths.size > 1) {
                            KIconButton(Lucide.ArrowLeft, "Previous", { dock.stepImage(-1) }, size = Size.SMALL)
                            Text("${v.index + 1} / ${v.paths.size}", style = k.ty.textXsmall, color = c.faint)
                            KIconButton(Lucide.ArrowRight, "Next", { dock.stepImage(1) }, size = Size.SMALL)
                        }
                        app.client?.let { client ->
                            KButton("Open in browser", { runCatching { uri.openUri(client.screenshotUrl(v.session, path)) } }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
                        }
                        KButton("Close", { dock.closeImage() }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
                    }
                    val swipe = Modifier.pointerInput(v.paths.size) {
                        var dx = 0f
                        detectHorizontalDragGestures(
                            onDragStart = { dx = 0f },
                            onDragEnd = { if (abs(dx) > 80f && v.paths.size > 1) dock.stepImage(if (dx < 0) 1 else -1) },
                        ) { _, amount -> dx += amount }
                    }
                    if (img == null) {
                        Text("Loading…", style = k.ty.body, color = c.faint)
                    } else {
                        // Screenshots are @2x: half their pixels in points, scaled to fit, at most twice.
                        val w = (img.width / 2f).coerceAtLeast(1f).dp
                        val h = (img.height / 2f).coerceAtLeast(1f).dp
                        val scale = minOf(maxW / w, maxH / h, 2f)
                        val shape = RoundedCornerShape(k.r.md)
                        Image(
                            img, path.substringAfterLast('/'),
                            Modifier.size(w * scale, h * scale).clip(shape).clickable(remember { MutableInteractionSource() }, indication = null) {}.then(swipe),
                            contentScale = ContentScale.Fit,
                        )
                    }
                }
            }
        }
    }
}

/** A sub-agent's own conversation, message by message. */
@Composable
private fun AgentWindow(app: AppModel, dock: DockModel, v: AgentViewer) {
    val c = k.c
    Floating({ dock.closeAgent() }, 860.dp, 0.8f) {
        Row(
            Modifier.fillMaxWidth().height(44.dp).bottomRule(c.border).padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(v.title, style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            KButton("Close", { dock.closeAgent() }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
        }
        val msgs = v.messages
        when {
            msgs == null -> Text("Loading the transcript…", style = k.ty.body, color = c.faint, modifier = Modifier.padding(16.dp))
            msgs.isEmpty() -> Text("This agent left no transcript.", style = k.ty.body, color = c.faint, modifier = Modifier.padding(16.dp))
            else -> LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(msgs) { AgentMessage(it) }
            }
        }
    }
}

/** One message of a subagent transcript, read-only: rune's bubble look without the session controls. */
@Composable
private fun AgentMessage(m: Message) {
    val c = k.c
    val user = m.role == "user"
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        Text(if (user) "Prompt" else "Agent", style = k.ty.textXsmallMedium, color = c.faint, modifier = Modifier.padding(bottom = 4.dp))
        Column(
            Modifier.fillMaxWidth(0.85f).clip(bubbleShape(user)).background(c.surface).border(1.dp, c.border, bubbleShape(user)).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (p in m.renderParts) when (p) {
                is MessagePart.Text -> MarkdownBody(p.text)
                is MessagePart.ToolUse -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    KIcon(Lucide.Tool, c.muted, 12.dp)
                    Text(p.tool.name, style = k.ty.textXsmallMedium, color = c.fg)
                    p.tool.detail?.let { Text(it, style = k.ty.textXsmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
    }
}
