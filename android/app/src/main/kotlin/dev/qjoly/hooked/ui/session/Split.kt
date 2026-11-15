package dev.qjoly.hooked.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.isArchived
import dev.qjoly.hooked.state.stateLabel
import dev.qjoly.hooked.ui.Bubble
import dev.qjoly.hooked.ui.ComposerField
import dev.qjoly.hooked.ui.ConverseEnv
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.launch

/** Opens the most recently active session not already on screen beside the others. */
fun splitWithRecent(app: AppModel, ui: SessionUi, main: String) {
    val shown = ui.splits + main
    app.visible.filter { it.id !in shown && !isArchived(it, app.meta, app.now) }
        .maxByOrNull { it.lastActivity ?: 0 }
        ?.let { ui.openSplit(it.id, main) }
}

/** view/split.rs: a session beside the main one, its last thirty messages and its own reply box. */
@Composable
fun SplitPane(app: AppModel, ui: SessionUi, id: String, main: String, modifier: Modifier, open: (PaneModal) -> Unit) {
    val client = app.client ?: return
    val c = k.c
    val ctx = LocalContext.current
    val model = remember(id, client) { SessionModel(id, client) }
    DisposableEffect(model) {
        model.say = app::say
        onDispose { model.close() }
    }
    LifecycleStartEffect(model) {
        model.start()
        onStopOrDispose { model.stop() }
    }
    LaunchedEffect(model, app.session(id)?.changeKey) { model.load() }
    LaunchedEffect(model.actionError) {
        model.actionError?.let {
            app.say("✗ $it")
            model.actionError = null
        }
    }
    val toolsOpen = remember(id) { mutableStateMapOf<String, Boolean>() }
    val env = remember(model) {
        ConverseEnv(app, model, ui, MediaEnv(client, id) { p, i, pasted -> open(PaneModal.Image(p, i, pasted)) }, toolsOpen, ctx) { open(PaneModal.Fork(it)) }
    }
    val x = app.session(id) ?: model.detail?.session
    val last = ui.splits.lastOrNull() == id
    Column(modifier.fillMaxHeight().background(c.bg).edge(c.border, start = true)) {
        Row(
            Modifier.fillMaxWidth().height(44.dp).edge(c.border, bottom = true).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Dot(c.stateColor(x?.state?.let(::stateKey)), 7.dp)
            Text(x?.let(app::title) ?: "Loading…", style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            x?.let { Text(stateLabel(it), style = k.ty.textXsmall, color = c.faint, maxLines = 1) }
            KIconButton(Lucide.Swap, "Make this the main pane", {
                val i = ui.splits.indexOf(id)
                if (i >= 0) ui.splits[i] = main
                app.open(id)
            })
            if (last && ui.splits.size < SessionUi.MAX_SPLITS) KIconButton(Lucide.Plus, "Add a pane", { splitWithRecent(app, ui, main) })
            KIconButton(Lucide.Close, "Close this pane", { ui.splits.remove(id) })
        }
        val conv = model.conversation
        val d = model.detail
        val state = rememberLazyListState()
        LaunchedEffect(conv?.turns?.size) { if (state.firstVisibleItemIndex <= 1) state.scrollToItem(0) }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = state,
            reverseLayout = true,
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            d?.pendingQuestion?.questions?.firstOrNull()?.let { q ->
                item(key = "q") {
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(k.r.md)).border(1.dp, c.warning.border, RoundedCornerShape(k.r.md)).padding(10.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        KIcon(Lucide.ArrowRight, c.warning.hue, 12.dp, Modifier.padding(top = 3.dp))
                        Text("Waiting on you: ${q.question}", style = k.ty.textSmall, color = c.muted, modifier = Modifier.weight(1f))
                    }
                }
            }
            val turns = conv?.turns.orEmpty()
            items(turns.takeLast(30).asReversed(), key = { "m-${it.index}" }) { Bubble(env, it) }
        }
        SplitComposer(model)
    }
}

@Composable
private fun SplitComposer(model: SessionModel) {
    val c = k.c
    val scope = rememberCoroutineScope()
    var value by remember(model.id) { mutableStateOf(TextFieldValue("")) }
    fun send() {
        val t = value.text.trim()
        if (t.isEmpty() || model.sending) return
        value = TextFieldValue("")
        scope.launch { if (!model.sendPrompt(t)) value = TextFieldValue(t, TextRange(t.length)) }
    }
    Row(
        Modifier.fillMaxWidth().edge(c.border, top = true).padding(10.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ComposerField(value, { value = it }, "Reply here…", Modifier.weight(1f), maxLines = 6, onKey = { e ->
            if (e.key == Key.Enter && !e.isShiftPressed) {
                send()
                true
            } else {
                false
            }
        })
        Box(Modifier.padding(bottom = 2.dp)) {
            KIconButton(Lucide.ArrowUp, "Send", ::send, variant = Variant.CONTRAST, size = Size.LARGE, enabled = !model.sending && value.text.isNotBlank())
        }
    }
}
