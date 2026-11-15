package dev.qjoly.hooked.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.state.AcItem
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.acApply
import dev.qjoly.hooked.state.acQuery
import dev.qjoly.hooked.state.firstLine
import dev.qjoly.hooked.state.modeLabel
import dev.qjoly.hooked.state.shortModelId
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// session.rs `composer`, `composer_field`, `autocomplete` and the resume bar.

private class Ac(val start: Int, val caret: Int, val items: List<AcItem>, val sel: Int = 0)

/** rune's TextArea: page fill, 1 border, radius md, grows from one line to ten. */
@Composable
fun ComposerField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    maxLines: Int = 10,
    onKey: (androidx.compose.ui.input.key.KeyEvent) -> Boolean = { false },
    onFocus: (Boolean) -> Unit = {},
) {
    val c = k.c
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(k.r.md)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        textStyle = k.ty.body.copy(color = c.fg),
        cursorBrush = SolidColor(c.accent),
        minLines = 1,
        maxLines = maxLines,
        modifier = modifier
            .onFocusChanged {
                focused = it.isFocused
                onFocus(it.isFocused)
            }
            .onPreviewKeyEvent { e -> e.type == KeyEventType.KeyDown && onKey(e) || (e.type == KeyEventType.KeyUp && e.key == Key.Enter && !e.isShiftPressed) },
        decorationBox = { inner ->
            Box(
                Modifier.clip(shape).background(c.bg).border(1.dp, if (focused) c.border2 else c.border, shape)
                    .heightIn(min = 32.dp).padding(horizontal = 10.dp, vertical = 6.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.text.isEmpty()) Text(placeholder, style = k.ty.body, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                inner()
            }
        },
    )
}

@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) =
    KIconButton(Lucide.ArrowUp, "Send", onClick, variant = Variant.CONTRAST, size = Size.LARGE, enabled = enabled)

@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun Composer(model: SessionModel, ui: SessionUi, onFocus: (Boolean) -> Unit = {}) {
    val d = model.detail ?: return
    val c = k.c
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var value by remember(model.id) { mutableStateOf(TextFieldValue(ui.draft(model.id)).let { it.copy(selection = TextRange(it.text.length)) }) }
    var ac by remember(model.id) { mutableStateOf<Ac?>(null) }
    val live = d.session.live
    val busy = model.isBusy
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(8)) { uris -> uris.forEach { model.attach(ctx, it) } }

    LaunchedEffect(model.id, value.text) {
        delay(400)
        ui.saveDraft(model.id, value.text)
    }
    DisposableEffect(model.id) { onDispose { ui.saveDraft(model.id, value.text) } }
    LaunchedEffect(model.id, value.text, value.selection) {
        val sel = value.selection
        val q = if (sel.collapsed) acQuery(value.text.substring(0, sel.start.coerceAtMost(value.text.length))) else null
        if (q == null) {
            ac = null
            return@LaunchedEffect
        }
        delay(120)
        val items = model.complete(q)
        val start = if (q is dev.qjoly.hooked.state.AcQuery.File) q.at else 0
        ac = if (items.isEmpty()) null else Ac(start, sel.start, items)
    }

    fun accept(i: Int? = null) {
        val a = ac ?: return
        ac = null
        val item = a.items.getOrNull(i ?: a.sel) ?: return
        val (text, caret) = acApply(value.text, a.start, a.caret, item) ?: return
        value = TextFieldValue(text, TextRange(caret))
    }

    val followup = (model.conversation?.followup ?: d.session.followup)
        ?.takeIf { it.isNotEmpty() && d.pendingQuestion == null && d.pendingPlan == null && model.queued.isEmpty() }

    fun send() {
        if (model.sending) return
        val text = value.text
        if (text.isBlank() && model.attachments.none { it.path != null }) return
        value = TextFieldValue("")
        ac = null
        scope.launch { if (!model.send(text)) value = TextFieldValue(text, TextRange(text.length)) }
    }

    fun onKey(e: androidx.compose.ui.input.key.KeyEvent): Boolean {
        val a = ac
        return when {
            a != null && e.key == Key.DirectionDown -> { ac = Ac(a.start, a.caret, a.items, (a.sel + 1).mod(a.items.size)); true }
            a != null && e.key == Key.DirectionUp -> { ac = Ac(a.start, a.caret, a.items, (a.sel - 1).mod(a.items.size)); true }
            a != null && (e.key == Key.Tab || e.key == Key.Enter) -> { accept(); true }
            a != null && e.key == Key.Escape -> { ac = null; true }
            e.key == Key.Tab && !e.isShiftPressed && value.text.isBlank() && followup != null -> {
                value = TextFieldValue(followup, TextRange(followup.length))
                true
            }
            e.key == Key.Enter && !e.isShiftPressed && !e.isAltPressed -> { send(); true }
            e.key == Key.Escape && busy -> { model.interrupt(); true }
            else -> false
        }
    }

    if (!live) {
        Column(Modifier.fillMaxWidth()) {
            ac?.let { a -> Box(Modifier.padding(horizontal = 20.dp)) { AutocompleteList(a, ::accept) } }
            Box(Modifier.fillMaxWidth().height(1.dp).background(c.border))
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("This session is not running. Send a message to resume it, or press Resume.", style = k.ty.ui, color = c.muted, modifier = Modifier.weight(1f))
                ComposerField(value, { value = it }, "Message to resume with…", Modifier.weight(1f), maxLines = 6, onKey = ::onKey, onFocus = onFocus)
                SendButton(!model.sending && value.text.isNotBlank(), ::send)
            }
        }
        return
    }

    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        followup?.let { f ->
            val shape = RoundedCornerShape(k.r.md)
            Row(
                Modifier.fillMaxWidth().clip(shape).border(1.dp, c.border, shape)
                    .combinedClickable(onLongClick = { value = TextFieldValue(f, TextRange(f.length)) }) { model.sendLater(f) }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                KIcon(Lucide.Zap, c.muted, 12.dp)
                Text(firstLine(f, 200), style = k.ty.ui, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text("Tap to send · hold or Tab ↹ to edit", style = k.ty.textXsmall, color = c.faint)
            }
        }
        ac?.let { AutocompleteList(it, ::accept) }
        if (model.attachments.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                model.attachments.forEach { a ->
                    val (status, color) = when {
                        a.failed -> "failed" to c.danger.fg
                        a.path != null -> "ready" to c.success.fg
                        else -> "uploading…" to c.faint
                    }
                    Row(
                        Modifier.height(26.dp).clip(RoundedCornerShape(k.r.md)).background(c.chip).padding(start = 8.dp, end = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        KIcon(Lucide.Image, c.muted, 12.dp)
                        Text(a.name, style = k.ty.textSmall, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
                        Text(status, style = k.ty.textXsmall, color = color)
                        KIconButton(Lucide.Close, "Remove", { model.attachments.removeAll { it.key == a.key } }, size = Size.SMALL)
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KIconButton(Lucide.Image, "Attach images", { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, size = Size.LARGE, modifier = Modifier.padding(bottom = 2.dp))
            ComposerField(
                value, { value = it }, if (busy) "Queue a message… (Esc interrupts)" else "Reply to Claude…",
                Modifier.weight(1f), onKey = ::onKey, onFocus = onFocus,
            )
            if (busy) KIconButton(Lucide.Stop, "Interrupt", { model.interrupt() }, variant = Variant.NEUTRAL, size = Size.LARGE, modifier = Modifier.padding(bottom = 2.dp))
            Box(Modifier.padding(bottom = 2.dp)) {
                SendButton(!model.sending && (value.text.isNotBlank() || model.attachments.any { it.path != null }), ::send)
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Mode: ${modeLabel(d.permissionMode ?: "default")}", style = k.ty.textXsmall, color = c.faint)
            Text("${d.session.model?.let(::shortModelId).orEmpty()} · ${d.session.effort.orEmpty()}", style = k.ty.textXsmall, color = c.faint)
            Spacer(Modifier.weight(1f))
            Text("Enter to send · Shift+Enter new line", style = k.ty.textXsmall, color = c.faint)
        }
    }
}

@Composable
private fun AutocompleteList(ac: Ac, onPick: (Int) -> Unit) {
    val c = k.c
    val shape = RoundedCornerShape(k.r.md)
    val first = (ac.sel - 7).coerceAtLeast(0)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.bg).border(1.dp, c.border, shape).padding(4.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        ac.items.withIndex().drop(first).take(8).forEach { (i, it) ->
            Pressable({ onPick(i) }, Modifier.fillMaxWidth().height(30.dp), fill = if (i == ac.sel) c.chip else Color.Transparent, radius = k.r.sm) {
                Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(it.label, style = k.ty.textSmallMedium, color = c.fg, maxLines = 1)
                    Text(it.sub, style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(it.badge, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                }
            }
        }
        Text("↑↓ to choose · Tab or Enter to insert · Esc to close", style = k.ty.textXsmall, color = c.faint, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
    }
}
