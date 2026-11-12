package dev.qjoly.hooked.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.SubdirectoryArrowLeft
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.qjoly.hooked.data.PermissionMode
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.SessionDetail
import dev.qjoly.hooked.data.display
import dev.qjoly.hooked.data.shortModel
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import kotlinx.coroutines.delay

/** The current time, ticking so ages and countdowns stay right. */
@Composable
fun rememberNow(periodMs: Long = 30_000): Long {
    val now by produceState(System.currentTimeMillis(), periodMs) {
        while (true) {
            delay(periodMs)
            value = System.currentTimeMillis()
        }
    }
    return now
}

@Composable
fun SessionPane(app: AppModel, id: String, onBack: (() -> Unit)?) {
    val client = app.client ?: return
    val model = remember(id, client) { SessionModel(id, client) }
    DisposableEffect(model) { onDispose { model.close() } }
    LifecycleStartEffect(model) {
        model.start()
        onStopOrDispose { model.stop() }
    }
    LaunchedEffect(model, app.session(id)?.changeKey) { model.load() }
    LaunchedEffect(model.actionError) {
        model.actionError?.let {
            app.message = it
            model.actionError = null
        }
    }
    val now = rememberNow(15_000)
    val summary = model.detail?.session ?: app.session(id)
    var controls by remember { mutableStateOf(false) }
    var confirmKill by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        Header(app, model, summary, now, onBack, onControls = { controls = true }, onKill = { confirmKill = true })
        HorizontalDivider(color = hooked.line)
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            Conversation(model, now)
        }
        BottomBar(model)
    }

    if (controls) model.detail?.let { ControlsDialog(app, model, it) { controls = false } }
    if (confirmKill) {
        AlertDialog(
            onDismissRequest = { confirmKill = false },
            title = { Text("Kill this session?") },
            text = { Text("The Claude process stops. The transcript stays available.") },
            confirmButton = {
                TextButton({
                    confirmKill = false
                    model.kill()
                }) { Text("Kill session") }
            },
            dismissButton = { TextButton({ confirmKill = false }) { Text("Cancel") } },
        )
    }
    model.heldSwitch?.let { h ->
        AlertDialog(
            onDismissRequest = { model.heldSwitch = null },
            title = { Text("The prompt cache is warm") },
            text = { Text("Switching models drops the cached prompt and re-sends the whole conversation.\n\n" + h.impact.display()) },
            confirmButton = {
                TextButton({
                    model.heldSwitch = null
                    model.setModel(h.model, h.effort, force = true)
                }) { Text("Switch anyway") }
            },
            dismissButton = { TextButton({ model.heldSwitch = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Header(
    app: AppModel, model: SessionModel, s: Session?, now: Long, onBack: (() -> Unit)?,
    onControls: () -> Unit, onKill: () -> Unit,
) {
    val d = model.detail
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(start = if (onBack == null) 24.dp else 8.dp, end = 12.dp, top = 12.dp, bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            onBack?.let { IconButton(it) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } }
            Column(Modifier.weight(1f)) {
                Text(
                    s?.displayTitle ?: "Session", style = MaterialTheme.typography.titleLarge.copy(fontSize = 22.sp),
                    color = hooked.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                val meta = listOfNotNull(s?.projectName, s?.gitBranch).joinToString(" · ")
                val tech = listOfNotNull(PermissionMode.label(d?.permissionMode).takeIf { d != null }, s?.model?.shortModel(), s?.effort).joinToString(" · ")
                Text(
                    listOf(meta, tech).filter { it.isNotEmpty() }.joinToString("   "), fontFamily = Mono, fontSize = 12.sp,
                    color = hooked.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                s?.let { StatePill(if (it.needsYou && it.state != dev.qjoly.hooked.data.SessionState.WAITING) decisionStyle() else stateStyle(it.state)) }
                s?.cache?.remainingMs(now)?.takeIf { it > 0 && s.live }?.let { CacheBadge(it) }
                if (d != null && !model.isLive) {
                    Button({ model.resume() }, enabled = !model.sending) {
                        Icon(Icons.Outlined.PlayCircle, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Resume")
                    }
                }
                if (model.isLive && model.isBusy) IconButton({ model.interrupt() }) { Icon(Icons.Rounded.Stop, "Interrupt") }
                IconButton(onControls, enabled = d != null) { Icon(Icons.Outlined.Tune, "Session controls") }
                Box {
                    IconButton({ menu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem({ Text("Refresh") }, { menu = false; model.refresh() }, leadingIcon = { Icon(Icons.Outlined.Refresh, null) })
                        DropdownMenuItem({ Text("Archive") }, { menu = false; app.archive(model.id) }, leadingIcon = { Icon(Icons.Outlined.Archive, null) })
                        if (model.isLive) {
                            DropdownMenuItem({ Text("Kill session") }, { menu = false; onKill() }, leadingIcon = { Icon(Icons.Outlined.DeleteForever, null) })
                        }
                    }
                }
            }
        }
        s?.todo?.takeIf { it.total > 0 }?.let { t ->
            Row(Modifier.padding(top = 8.dp, start = if (onBack == null) 0.dp else 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.Checklist, null, Modifier.size(16.dp), tint = hooked.muted)
                LinearProgressIndicator({ t.done.toFloat() / t.total }, Modifier.width(120.dp), color = stateStyle(dev.qjoly.hooked.data.SessionState.WORKING).hue, trackColor = hooked.line)
                Text("${t.done}/${t.total}" + (t.current?.let { "  ·  $it" } ?: ""), fontSize = 12.sp, color = hooked.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Related(app, model, s)
    }
}

@Composable
private fun CacheBadge(remainingMs: Long) {
    Surface(shape = MaterialTheme.shapes.small, color = hooked.card, border = BorderStroke(1.dp, hooked.line)) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(Icons.Outlined.Bolt, null, Modifier.size(14.dp), tint = hooked.ink)
            Text("Cache · ${(remainingMs / 60_000).coerceAtLeast(1)} min", fontFamily = Mono, fontSize = 11.5.sp, color = hooked.ink)
        }
    }
}

/** The group's lead and siblings, then the sessions this one launched or linked to. */
@Composable
private fun Related(app: AppModel, model: SessionModel, s: Session?) {
    val group = s?.group
    val ids = buildList {
        group?.members?.filter { it != model.id }?.let(::addAll)
        model.detail?.subSessions?.forEach { if (it.id != model.id && it.id !in this) add(it.id) }
    }
    if (ids.isEmpty()) return
    val labels = model.detail?.subSessions?.associate { it.id to it.label }.orEmpty()
    LazyRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(ids, key = { it }) { rid ->
            val r = app.session(rid)
            val style = r?.let { if (it.needsYou) decisionStyle() else stateStyle(it.state) } ?: stateStyle(dev.qjoly.hooked.data.SessionState.UNKNOWN)
            AssistChip(
                onClick = { app.open(rid) },
                label = { Text(r?.displayTitle ?: labels[rid]?.ifEmpty { null } ?: rid.take(8), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp)) },
                leadingIcon = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (rid == group?.mother) Icon(Icons.Outlined.SubdirectoryArrowLeft, "Lead session", Modifier.size(14.dp))
                        StateDot(style, size = 8.dp)
                    }
                },
                colors = AssistChipDefaults.assistChipColors(containerColor = hooked.card),
                border = BorderStroke(1.dp, hooked.line),
            )
        }
    }
}

@Composable
private fun Conversation(model: SessionModel, now: Long) {
    val d = model.detail
    if (d == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            model.loadError?.let { Text(it, color = hooked.muted) } ?: CircularProgressIndicator()
        }
        return
    }
    val state = rememberLazyListState()
    val snap = model.snapshot
    // A new bottom item lands below the viewport, since the list stays anchored on the item it showed:
    // follow it when the reader was at the bottom.
    LaunchedEffect(d.messages.size, snap?.busy, snap?.text?.length, model.outgoing, d.pendingLeadIn) {
        if (state.firstVisibleItemIndex <= 1) state.scrollToItem(0)
    }
    // Newest first in a reversed list: the view stays pinned to the bottom as the turn streams in.
    LazyColumn(
        Modifier.widthIn(max = ConversationWidth).fillMaxSize(),
        state = state,
        reverseLayout = true,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (snap != null && snap.busy) item(key = "live") { LiveBubble(snap) }
        model.outgoing?.let { o -> item(key = "out") { UserBubble(o, null, now, queued = true) } }
        d.pendingLeadIn?.takeIf { d.session.live }?.let { item(key = "lead") { AssistantCard(listOf(dev.qjoly.hooked.data.MessagePart.Text(it)), null, now) } }
        items(d.messages.asReversed(), key = { "m${it.id}" }) { MessageRow(it, now) }
        if (d.messages.isEmpty()) item(key = "empty") { SystemLine("Empty conversation") }
    }
}

@Composable
private fun BottomBar(model: SessionModel) {
    val d = model.detail ?: return
    Surface(color = hooked.panel, tonalElevation = 0.dp) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            HorizontalDivider(color = hooked.line)
            Column(Modifier.widthIn(max = ConversationWidth).fillMaxWidth()) {
                if (d.session.live && (d.pendingPlan != null || d.pendingQuestion != null)) {
                    Box(Modifier.padding(horizontal = 12.dp).padding(top = 10.dp).heightIn(max = 440.dp).verticalScroll(rememberScrollState())) {
                        DecisionFrame {
                            val busy = !model.sending
                            d.pendingPlan?.let { PlanCard(it, busy) { a, f -> model.plan(a, f) } }
                                ?: d.pendingQuestion?.let { q ->
                                    if (q.isPermission) PermissionCard(q, busy) { sel, note -> model.answer(sel, note) }
                                    else QuestionCard(q, busy) { sel, note -> model.answer(sel, note) }
                                }
                        }
                    }
                }
                if (!model.isLive) {
                    Text(
                        "Not running. Sending a message resumes it.", fontSize = 12.sp, color = hooked.muted,
                        modifier = Modifier.padding(start = 24.dp, top = 8.dp),
                    )
                }
                Composer(model, answering = model.isLive && d.pendingQuestion?.isPermission == false, followup = d.session.followup)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ControlsDialog(app: AppModel, model: SessionModel, d: SessionDetail, onDismiss: () -> Unit) {
    val live = model.isLive
    val caps = app.capabilities
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Session controls") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                if (!live) Text("Resume the session to change these.", color = hooked.muted, fontSize = 13.sp)
                Label("Permission mode")
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    PermissionMode.live.forEachIndexed { i, m ->
                        SegmentedButton(
                            selected = (d.permissionMode ?: "default") == m,
                            onClick = { model.setMode(m) },
                            shape = SegmentedButtonDefaults.itemShape(i, PermissionMode.live.size),
                            enabled = live,
                        ) { Text(PermissionMode.label(m)) }
                    }
                }
                if (caps.models.isNotEmpty()) {
                    Label("Model")
                    var open by remember { mutableStateOf(false) }
                    ExposedDropdownMenuBox(open, { if (live) open = it }) {
                        OutlinedTextField(
                            value = d.session.model?.let(caps::modelLabel) ?: "Default", onValueChange = {}, readOnly = true, enabled = live,
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
                            modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
                        )
                        ExposedDropdownMenu(open, { open = false }) {
                            caps.models.forEach { g ->
                                Text(g.label.uppercase(), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = hooked.muted, modifier = Modifier.padding(start = 16.dp, top = 10.dp, bottom = 4.dp))
                                g.options.forEach { o ->
                                    DropdownMenuItem({ Text(caps.modelLabel(o.id)) }, {
                                        open = false
                                        model.setModel(o.id, null)
                                    })
                                }
                            }
                        }
                    }
                }
                if (caps.efforts.isNotEmpty()) {
                    Label("Effort")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        caps.efforts.forEach { e ->
                            FilterChip(d.session.effort == e, { model.setModel(null, e) }, { Text(e.replaceFirstChar(Char::uppercase)) }, enabled = live)
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Auto-approve tools", style = MaterialTheme.typography.titleSmall, color = hooked.ink)
                        Text("Permission requests are allowed without asking.", fontSize = 12.sp, color = hooked.muted)
                    }
                    Switch(d.autoApprove, { model.setAutoApprove(it) }, enabled = live)
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Done") } },
    )
}

@Composable
private fun Label(text: String) {
    Text(text.uppercase(), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = hooked.muted, letterSpacing = 0.6.sp)
}
