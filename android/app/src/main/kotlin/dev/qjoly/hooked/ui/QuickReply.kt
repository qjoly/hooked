package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.QuickMsg
import dev.qjoly.hooked.state.quickItems
import dev.qjoly.hooked.state.quickMessages
import dev.qjoly.hooked.state.quickReason
import dev.qjoly.hooked.state.quickStep
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * rune's quick reply window (quick.rs): the sessions waiting on you on the left, the end of the
 * selected conversation on the right, a reply field below. A 760 × 500 panel 140 from the top.
 */
@Composable
fun QuickReply(app: AppModel) {
    val kit = k
    val close = { app.quickOpen = false }
    Dialog(close, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        ProvideKit(kit) {
            BoxWithConstraints(
                Modifier.fillMaxSize().imePadding().clickable(remember { MutableInteractionSource() }, indication = null, onClick = close),
                contentAlignment = Alignment.TopCenter,
            ) {
                val top = if (maxHeight >= 140.dp + 500.dp + 16.dp) 140.dp else maxOf(16.dp, maxHeight - 500.dp - 16.dp)
                Panel(app, Modifier.padding(top = top).width(minOf(760.dp, maxWidth - 32.dp)).heightIn(max = minOf(500.dp, maxHeight - top - 16.dp)), close)
            }
        }
    }
}

@Composable
private fun Panel(app: AppModel, modifier: Modifier, close: () -> Unit) {
    val c = k.c
    val client = app.client ?: return
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf(quickItems(app.visible, app.meta, app.now)) }
    var at by remember { mutableIntStateOf(0) }
    var msgs by remember { mutableStateOf<List<QuickMsg>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var reply by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        app.refresh()
        items = quickItems(app.visible, app.meta, System.currentTimeMillis())
        at = 0
    }
    val current = items.getOrNull(at)
    LaunchedEffect(current?.id) {
        msgs = emptyList()
        val id = current?.id ?: return@LaunchedEffect
        loading = true
        val d = runCatching { client.detail(id) }.getOrNull()
        loading = false
        if (d != null) msgs = quickMessages(d.messages, d.pendingQuestion)
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    fun send() {
        val body = reply.trim()
        val x = current ?: return
        if (body.isEmpty()) return
        note = "sending…"
        scope.launch {
            try {
                if (x.live) client.reply(x.id, body) else client.resume(x.id, body, x.effort)
                reply = ""
                note = ""
                app.refreshSoon()
                close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                note = e.message ?: "Failed"
            }
        }
    }
    fun openInApp() {
        val x = current ?: return
        app.open(x.id)
        close()
    }
    fun step(d: Int) {
        if (items.isNotEmpty()) at = quickStep(at, items.size, d)
    }
    val shape = RoundedCornerShape(14.dp)
    val line = c.border
    Row(
        modifier.shadow(16.dp, shape, ambientColor = c.shadow, spotColor = c.shadow).clip(shape).background(c.bg).border(1.dp, c.border, shape)
            .clickable(remember { MutableInteractionSource() }, indication = null) {},
    ) {
        Column(
            Modifier.width(250.dp).fillMaxHeight()
                .drawBehind { drawLine(line, Offset(size.width - 0.5f, 0f), Offset(size.width - 0.5f, size.height), 1.dp.toPx()) }
                .verticalScroll(rememberScrollState()).padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            items.forEachIndexed { i, x ->
                val on = i == at
                Pressable({ at = i; runCatching { focus.requestFocus() } }, Modifier.fillMaxWidth(), fill = if (on) c.chip else Color.Transparent, radius = k.r.md) {
                    Column(Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Dot(c.stateColor(x.state.name.lowercase()), 6.dp)
                            Text(x.displayTitle, style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        }
                        Text("${x.projectName.orEmpty()} — ${quickReason(x)}", style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Column(Modifier.weight(1f).fillMaxHeight()) {
            val scroll = rememberScrollState()
            // The end of the conversation is what matters: stick to the bottom.
            LaunchedEffect(msgs, scroll.maxValue) { scroll.scrollTo(scroll.maxValue) }
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when {
                    items.isEmpty() -> Text("Nothing is waiting on you.", style = k.ty.body, color = c.faint)
                    loading -> Text("Loading the conversation…", style = k.ty.ui, color = c.faint)
                }
                msgs.forEach { m ->
                    Column(
                        Modifier.fillMaxWidth().then(if (m.user) Modifier.clip(RoundedCornerShape(k.r.md)).background(c.surface).padding(10.dp) else Modifier),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(if (m.user) "You" else "Claude", style = k.ty.textXsmallMedium, color = c.faint)
                        MarkdownBody(m.text)
                    }
                }
            }
            Column(
                Modifier.fillMaxWidth().drawBehind { drawLine(line, Offset(0f, 0.5f), Offset(size.width, 0.5f), 1.dp.toPx()) }.padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                KTextInput(
                    reply, { reply = it }, "Reply… (Enter sends, ↑↓ switches, ⌘O opens in hooked, Esc closes)",
                    Modifier.fillMaxWidth().heightIn(max = 136.dp).focusRequester(focus).onPreviewKeyEvent { e ->
                        if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when {
                            e.key == Key.Enter && !e.isShiftPressed -> { send(); true }
                            (e.key == Key.DirectionUp || e.key == Key.DirectionDown) && reply.isEmpty() -> { step(if (e.key == Key.DirectionUp) -1 else 1); true }
                            e.key == Key.Escape -> { close(); true }
                            e.key == Key.O && (e.isMetaPressed || e.isCtrlPressed) -> { openInApp(); true }
                            else -> false
                        }
                    },
                    singleLine = false,
                )
                // Touch has no Enter or ⌘O: the same two actions as buttons.
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(note, style = k.ty.textXsmall, color = c.faint, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    KButton("Open in hooked", ::openInApp, variant = Variant.GHOST_MUTED, icon = Lucide.ArrowRight, enabled = current != null)
                    KButton("Send", ::send, variant = Variant.CONTRAST, enabled = current != null && reply.isNotBlank())
                }
            }
        }
    }
}

/** ⌘B folds the sidebar; ⌘⇧H opens quick reply, rune's global shortcut. */
fun organizeShortcut(app: AppModel, e: androidx.compose.ui.input.key.KeyEvent): Boolean {
    if (!(e.isMetaPressed || e.isCtrlPressed)) return false
    val down = e.type == KeyEventType.KeyDown
    when {
        e.key == Key.B && !e.isShiftPressed -> if (down) app.prefs.sidebarOpen(!app.prefs.sidebarOpen)
        e.key == Key.H && e.isShiftPressed -> if (down) app.quickOpen = !app.quickOpen
        else -> return false
    }
    return true
}
