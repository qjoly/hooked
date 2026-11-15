package dev.qjoly.hooked.ui.session

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.display
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.launchInGroup
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.LAUNCH_MODES
import dev.qjoly.hooked.state.LIVE_MODES
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.conversationMarkdown
import dev.qjoly.hooked.state.costLabel
import dev.qjoly.hooked.state.groupMembers
import dev.qjoly.hooked.state.modeLabel
import dev.qjoly.hooked.state.of
import dev.qjoly.hooked.state.projectLabel
import dev.qjoly.hooked.state.shortModelId
import dev.qjoly.hooked.state.spanSep
import dev.qjoly.hooked.state.stateLabel
import dev.qjoly.hooked.state.tokensLabel
import dev.qjoly.hooked.state.visibleModels
import dev.qjoly.hooked.ui.ComposerField
import dev.qjoly.hooked.ui.KModal
import dev.qjoly.hooked.ui.SidebarModal
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.KMenu
import dev.qjoly.hooked.ui.kit.KMenuGroup
import dev.qjoly.hooked.ui.kit.KMenuItem
import dev.qjoly.hooked.ui.kit.KMenuSeparator
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.TagPill
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.rememberNow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** The pane's floating layers. */
sealed interface PaneModal {
    data object Cost : PaneModal
    data class Fork(val uuid: String) : PaneModal
    data class NewInGroup(val mother: String) : PaneModal
    data class Image(val paths: List<String>, val index: Int, val pasted: Boolean) : PaneModal
    data class Organize(val m: SidebarModal) : PaneModal
}

fun stateKey(s: SessionState) = s.name.lowercase()

/** session.rs `head`: the title line, then repo · branch, tags, the context gauge and the cache. */
@Composable
fun SessionHeader(app: AppModel, model: SessionModel, ui: SessionUi, onBack: () -> Unit, onSplit: () -> Unit, open: (PaneModal) -> Unit) {
    val d = model.detail ?: return
    val x = app.session(model.id) ?: d.session
    val c = k.c
    val stateText = if (x.state == SessionState.WORKING) "${x.activity ?: "Working"}…" else stateLabel(x)
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Row(Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                KIconButton(Lucide.ArrowLeft, "Back to the Deck", onBack)
                Text(app.title(x), style = k.ty.bodyMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Row(
                    Modifier.height(22.dp).clip(RoundedCornerShape(11.dp)).background(c.chip).padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Dot(c.stateColor(stateKey(x.state)), 7.dp)
                    Text(stateText, style = k.ty.textXsmallMedium, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!d.session.live) KButton("Resume", { model.resume() }, variant = Variant.NEUTRAL, size = Size.REGULAR, icon = Lucide.Play, enabled = !model.sending)
                val archived = app.meta.of(model.id).archived
                KIconButton(if (archived) Lucide.Unarchive else Lucide.Archive, if (archived) "Restore" else "Archive", { app.toggleArchive(model.id) })
                KIconButton(Lucide.Split, "Split view", onSplit, variant = if (ui.splits.isNotEmpty()) Variant.NEUTRAL else Variant.GHOST_MUTED)
                KIconButton(if (ui.dockOpen) Lucide.PanelRight else Lucide.Sidebar, "Toggle the context panel", { ui.toggleDock() }, on = ui.dockOpen)
                KIconButton(if (ui.focus) Lucide.Sidebar else Lucide.Monitor, "Focus mode", { toggleFocus(app, ui) }, variant = if (ui.focus) Variant.GHOST else Variant.GHOST_MUTED, on = ui.focus)
                MoreMenu(app, model, ui, open)
            }
        }
        SubLine(app, model, open)
    }
}

/** Focus mode: the conversation alone. The sidebar folds to the rail and comes back after. */
fun toggleFocus(app: AppModel, ui: SessionUi) {
    ui.focus = !ui.focus
    if (ui.focus) {
        focusHadSidebar = app.prefs.sidebarOpen
        if (focusHadSidebar) app.prefs.sidebarOpen(false)
    } else if (focusHadSidebar) {
        app.prefs.sidebarOpen(true)
    }
}

private var focusHadSidebar = false

@Composable
private fun SubLine(app: AppModel, model: SessionModel, open: (PaneModal) -> Unit) {
    val d = model.detail ?: return
    val x = app.session(model.id) ?: d.session
    val c = k.c
    val now = rememberNow(15_000)
    Row(Modifier.fillMaxWidth().height(24.dp).padding(start = 54.dp, end = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.weight(1f, fill = false), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(projectLabel(x), style = k.ty.ui, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            x.gitBranch?.takeIf { it.isNotEmpty() }?.let { b ->
                Text("·", style = k.ty.ui, color = c.faint)
                KIcon(Lucide.GitBranch, c.faint, 12.dp)
                Text(b, style = k.ty.ui, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
        }
        val tags = app.tagsOf(model.id)
        if (tags.isNotEmpty()) {
            Row(
                Modifier.weight(1f, fill = false).clip(RoundedCornerShape(k.r.sm)).clickable { open(PaneModal.Organize(SidebarModal.Tags(model.id))) },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) { tags.forEach { TagPill(it, app.prefs.tagColors) } }
        }
        Spacer(Modifier.weight(0.01f))
        model.conversation?.contextPct?.let { pct ->
            val p = pct.coerceIn(0.0, 100.0).toFloat()
            val fill = when {
                p >= 90 -> c.danger.hue
                p >= 75 -> c.warning.hue
                else -> c.muted
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("CTX", style = k.ty.textXsmallMedium, color = c.faint)
                Box(Modifier.width(48.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(c.border)) {
                    Box(Modifier.width((48 * p / 100).dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(fill))
                }
                Text("${pct.toInt()}%", style = k.ty.textXsmallMedium, color = c.muted)
            }
        }
        x.cache?.let { cache ->
            val left = cache.remainingMs(now)
            Text(
                if (left > 0) "⚡ warm ${spanSep(left)}" else "cold cache",
                style = k.ty.textXsmallMedium,
                color = if (left > 0) c.success.fg else c.faint,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun MoreMenu(app: AppModel, model: SessionModel, ui: SessionUi, open: (PaneModal) -> Unit) {
    val d = model.detail ?: return
    val x = d.session
    val ctx = LocalContext.current
    var menu by remember { mutableStateOf<String?>(null) }
    val close = { menu = null }
    fun shows(key: String) = (app.settings["statusBar"][key]?.let { it.bool }) ?: true
    val currentModel = x.model.orEmpty()
    val conv = model.conversation
    Box {
        KIconButton(Lucide.More, "More actions", { menu = if (menu == null) "more" else null }, on = menu != null)
        KMenu(menu == "more", close, minWidth = 280.dp) {
            if (x.live) {
                if (shows("modelEffort")) {
                    KMenuGroup("Model · ${shortModelId(currentModel)}")
                    KMenuItem("Model", { menu = "model" }, trailing = "${shortModelId(currentModel)} ›")
                    KMenuItem("Effort", { menu = "effort" }, trailing = "${x.effort.orEmpty()} ›")
                    KMenuSeparator()
                }
                if (shows("permissionMode")) {
                    KMenuGroup("Permission mode")
                    LIVE_MODES.forEach { m ->
                        KMenuItem(modeLabel(m), { close(); model.setMode(m) }, checked = (d.permissionMode ?: "default") == m)
                    }
                }
                KMenuItem(
                    "Auto-approve · ${if (d.autoApprove) "on" else "off"}", { close(); model.setAutoApprove(!d.autoApprove) },
                    description = "Allow tool permission requests without asking", checked = d.autoApprove,
                )
                KMenuSeparator()
            }
            KMenuItem("Copy as Markdown", {
                close()
                conv?.let {
                    copyText(ctx, conversationMarkdown(it), "conversation")
                    app.say("✓ Conversation copied as Markdown")
                }
            }, icon = Lucide.Copy, description = "The whole conversation, tool calls included")
            KMenuItem("Share as Markdown…", {
                close()
                conv?.let {
                    val send = Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_TEXT, conversationMarkdown(it))
                        .putExtra(Intent.EXTRA_SUBJECT, app.title(x))
                    runCatching { ctx.startActivity(Intent.createChooser(send, "Export the conversation").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
            }, icon = Lucide.Link, description = "Send the export to another app")
            KMenuItem("Cost · ${costLabel(x.cost)}", { close(); open(PaneModal.Cost) }, description = "Where the money went: input, output, cache")
            KMenuSeparator()
            KMenuItem("Edit tags…", { close(); open(PaneModal.Organize(SidebarModal.Tags(model.id))) }, icon = Lucide.Tag)
            KMenuItem("Move to group…", { close(); open(PaneModal.Organize(SidebarModal.Group(model.id))) }, icon = Lucide.List)
            val groupOf = app.meta.of(model.id).groupOf?.takeIf { it != model.id }
            val leads = groupOf == null && groupMembers(model.id, app.sessions, app.meta).size > 1
            when {
                groupOf != null -> KMenuItem("Leave the group", { close(); app.groupOp("leave", model.id) })
                leads -> KMenuItem("Rename the group…", { close(); open(PaneModal.Organize(SidebarModal.RenameGroup(model.id))) })
                else -> KMenuItem("Not in a group", {}, enabled = false)
            }
            val incognito = app.meta.of(model.id).incognito
            KMenuItem(
                if (incognito) "Remove from incognito" else "Mark incognito", { close(); app.toggleIncognito(model.id) },
                icon = if (incognito) Lucide.Eye else Lucide.EyeOff, description = "Incognito sessions stay visible in incognito mode",
            )
            KMenuSeparator()
            KMenuItem("Open in editor", { close(); model.openEditor() }, icon = Lucide.Code)
            KMenuItem("Open in the web dashboard", { close(); app.client?.let { openUrl(ctx, it.url("session/${model.id}")) } }, icon = Lucide.Link)
            KMenuItem("Copy resume command", {
                close()
                copyText(ctx, "cd ${x.project.orEmpty()} && claude --resume ${x.id}")
                app.say("✓ Copied")
            }, icon = Lucide.Copy)
            KMenuItem(if (ui.allToolsOpen) "Collapse tool calls" else "Expand tool calls", { close(); ui.allToolsOpen = !ui.allToolsOpen }, icon = Lucide.Tool)
            KMenuSeparator()
            KMenuItem("Restart Claude", { close(); model.restart() }, icon = Lucide.Restart, description = "Stop the process and resume it from its transcript")
            KMenuItem("Move to trash", { close(); model.trash {
                    app.refreshSoon()
                    app.openDeck()
                } }, icon = Lucide.Trash, danger = true)
        }
        KMenu(menu == "model", close, minWidth = 240.dp) {
            KMenuGroup("Model")
            val hidden = app.settings["hiddenModels"].arr.mapNotNull { it.str }.toSet()
            visibleModels(app.capabilities, hidden).forEach { (id, label) ->
                KMenuItem(label, {
                    close()
                    val force = model.heldSwitch?.model == id
                    model.heldSwitch = null
                    model.setModel(id, x.effort, force)
                }, checked = currentModel.contains(id.removePrefix("claude-")))
            }
        }
        KMenu(menu == "effort", close, minWidth = 200.dp) {
            KMenuGroup("Effort")
            app.capabilities.efforts.forEach { e ->
                KMenuItem(e, { close(); model.setModel(null, e) }, checked = x.effort == e)
            }
        }
    }
}

/** view/organize.rs `cost`: input, output and the two cache lines as shares of the total. */
@Composable
fun CostModal(model: SessionModel, onClose: () -> Unit) {
    val c = k.c
    val conv = model.conversation
    val cb = conv?.costBreak
    val usage = conv?.usage
    val parts = listOf(
        Triple("Input", "input", c.info.fg),
        Triple("Output", "output", c.success.fg),
        Triple("Cache write", "cacheCreate", c.warning.fg),
        Triple("Cache read", "cacheRead", c.danger.fg),
    )
    val total = parts.sumOf { cb[it.second].dbl ?: 0.0 }.coerceAtLeast(1e-9)
    KModal(onClose, "Cost of this session") {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            parts.forEach { (label, key, color) ->
                val v = cb[key].dbl ?: 0.0
                val share = (v / total).toFloat()
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(label, style = k.ty.textSmallMedium, color = c.fg)
                        Text("${tokensLabel(usage[key].dbl ?: 0.0)} tokens", style = k.ty.textXsmall, color = c.faint)
                        Spacer(Modifier.weight(1f))
                        Text("${costLabel(v)} · ${(share * 100).toInt()}%", style = k.ty.textSmall, color = c.muted)
                    }
                    Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(c.chip)) {
                        Box(Modifier.fillMaxWidth(share.coerceIn(0f, 1f)).height(6.dp).clip(RoundedCornerShape(3.dp)).background(color))
                    }
                }
            }
            val sub = conv?.subagentCost?.takeIf { it > 0 }
            Text("Total ${costLabel(model.detail?.session?.cost)}" + (sub?.let { " · subagents ${costLabel(it)}" } ?: ""), style = k.ty.uiMedium, color = c.fg)
            Text("Rates: Fable 10/50, Opus 5/25, Sonnet 3/15, Haiku 1/5 \$/Mtok; cache write ×1.25, read ×0.1.", style = k.ty.textXsmall, color = c.faint)
        }
    }
}

/** The server held a model switch: the cache would be re-written. */
@Composable
fun HeldSwitchModal(model: SessionModel) {
    val h = model.heldSwitch ?: return
    KModal({ model.heldSwitch = null }, "The prompt cache is warm") {
        Text("Switching model now re-caches the whole conversation.", style = k.ty.textSmall, color = k.c.muted)
        if (h.impact.isNotEmpty()) Text(h.impact.display(), style = k.ty.mono, color = k.c.faint)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            KButton("Cancel", { model.heldSwitch = null }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
            KButton("Switch anyway", {
                model.heldSwitch = null
                model.setModel(h.model, h.effort, force = true)
            }, variant = Variant.CONTRAST, size = Size.REGULAR)
        }
    }
}

@Composable
private fun Chip(label: String, on: Boolean, onClick: () -> Unit) {
    val c = k.c
    val shape = RoundedCornerShape(k.r.md)
    Box(
        Modifier.height(26.dp).clip(shape).background(if (on) c.chip else Color.Transparent)
            .border(1.dp, if (on) c.border2 else c.border, shape).clickable(onClick = onClick).padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = k.ty.textSmall, color = if (on) c.fg else c.muted, maxLines = 1) }
}

/** Model, effort and mode chips, as the fork and launch pickers lay them out. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LaunchOptions(app: AppModel, model: String?, effort: String?, mode: String, onModel: (String?) -> Unit, onEffort: (String?) -> Unit, onMode: (String) -> Unit) {
    val hidden = app.settings["hiddenModels"].arr.mapNotNull { it.str }.toSet()
    @Composable
    fun line(label: String, body: @Composable () -> Unit) = Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionTitle(label)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { body() }
    }
    line("MODEL") { visibleModels(app.capabilities, hidden).forEach { (id, label) -> Chip(label, model == id) { onModel(id) } } }
    line("EFFORT") { app.capabilities.efforts.forEach { e -> Chip(e, effort == e) { onEffort(e) } } }
    line("MODE") { LAUNCH_MODES.forEach { m -> Chip(modeLabel(m), mode == m) { onMode(m) } } }
}

/** view/organize.rs `fork`: branch from a message with its own model, effort, mode and first message. */
@Composable
fun ForkModal(app: AppModel, model: SessionModel, uuid: String, onClose: () -> Unit) {
    val s = model.detail?.session
    var m by remember { mutableStateOf(s?.model) }
    var e by remember { mutableStateOf(s?.effort) }
    var mode by remember { mutableStateOf("default") }
    var prompt by remember { mutableStateOf(TextFieldValue("")) }
    KModal(onClose, "Fork from this message") {
        LaunchOptions(app, m, e, mode, { m = it }, { e = it }, { mode = it })
        ComposerField(prompt, { prompt = it }, "New direction from this point… (leave empty to just open the branch)", Modifier.fillMaxWidth(), maxLines = 8)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            KButton("Cancel", onClose, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
            KButton("Fork", {
                onClose()
                model.fork(uuid, prompt.text.trim(), m, e, mode) {
                    app.refreshSoon()
                    app.open(it)
                }
            }, variant = Variant.CONTRAST, size = Size.REGULAR)
        }
    }
}

/** A new session in the lead's folder, joined to its group. */
@Composable
fun NewInGroupModal(app: AppModel, mother: String, onClose: () -> Unit) {
    val lead = app.session(mother) ?: return onClose()
    val scope = rememberCoroutineScope()
    var m by remember { mutableStateOf<String?>(null) }
    var e by remember { mutableStateOf<String?>(null) }
    var mode by remember { mutableStateOf(app.settings["defaultMode"].text ?: "default") }
    var prompt by remember { mutableStateOf(TextFieldValue("")) }
    var busy by remember { mutableStateOf(false) }
    val cwd = lead.project.orEmpty()
    KModal(onClose, "New session in this group") {
        Text(cwd.ifEmpty { "No folder for this group" }, style = k.ty.textSmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        LaunchOptions(app, m, e, mode, { m = it }, { e = it }, { mode = it })
        ComposerField(prompt, { prompt = it }, "What should this session do?", Modifier.fillMaxWidth(), maxLines = 8)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            KButton("Cancel", onClose, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
            KButton("Launch", {
                val client = app.client ?: return@KButton
                busy = true
                scope.launch {
                    try {
                        val id = client.launchInGroup(cwd, prompt.text.trim(), mother, m, e, mode)
                        app.say("✓ Session launched")
                        app.refresh()
                        app.open(id)
                        onClose()
                    } catch (ex: CancellationException) {
                        throw ex
                    } catch (ex: Exception) {
                        app.say("✗ Launch: ${ex.message}")
                    } finally {
                        busy = false
                    }
                }
            }, variant = Variant.CONTRAST, size = Size.REGULAR, enabled = !busy && cwd.isNotEmpty())
        }
    }
}
