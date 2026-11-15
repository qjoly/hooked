package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.checkoutBranch
import dev.qjoly.hooked.data.claudeInfo
import dev.qjoly.hooked.data.cleanTag
import dev.qjoly.hooked.data.cleanupWorktrees
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.gitInfo
import dev.qjoly.hooked.data.jsonStrings
import dev.qjoly.hooked.data.obj
import dev.qjoly.hooked.data.parseWorkHours
import dev.qjoly.hooked.data.pullCheckouts
import dev.qjoly.hooked.data.remoteControl
import dev.qjoly.hooked.data.replaceTags
import dev.qjoly.hooked.data.resyncStates
import dev.qjoly.hooked.data.retag
import dev.qjoly.hooked.data.runWarmup
import dev.qjoly.hooked.data.saveSetting
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.strList
import dev.qjoly.hooked.data.tagMap
import dev.qjoly.hooked.data.toggled
import dev.qjoly.hooked.data.upgradeClaude
import dev.qjoly.hooked.data.warmupInfo
import dev.qjoly.hooked.data.withNested
import dev.qjoly.hooked.data.workHoursText
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.pages.PageFrame
import dev.qjoly.hooked.ui.pages.PageLoading
import dev.qjoly.hooked.ui.pages.PageModel
import dev.qjoly.hooked.ui.pages.PageSwitch
import dev.qjoly.hooked.ui.pages.endRule
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The Settings page's state, kept across visits like rune's `PageData`. */
class SettingsModel : PageModel() {
    /** The server settings as last saved here; the source of every control. */
    var v by mutableStateOf<JsonObject?>(null)
        private set
    var claude by mutableStateOf<JsonElement?>(null)
    var git by mutableStateOf<JsonElement?>(null)
    var rc by mutableStateOf<JsonElement?>(null)
    var warmup by mutableStateOf<JsonElement?>(null)
    var busy by mutableStateOf<String?>(null)
    var wtCleanup by mutableStateOf<JsonElement?>(null)
    var wtPull by mutableStateOf<JsonElement?>(null)
    var project by mutableStateOf("")
    var hours by mutableStateOf("")
    var wtLocation by mutableStateOf("")
    var wtNames by mutableStateOf("")

    /** The tag being renamed and the name typed so far. */
    var tagEdit by mutableStateOf<Pair<String, String>?>(null)
    var hueOpen by mutableStateOf<String?>(null)
    var branchesOpen by mutableStateOf(false)
    var checkoutDirty by mutableStateOf<String?>(null)

    /** Tags as rewritten here, until the next refresh brings the server's. */
    var localTags by mutableStateOf<Map<String, List<String>>?>(null)
        private set

    fun setting(key: String): JsonElement? = v?.get(key)

    /** Entering the page rereads everything, as rune's `go(Page::Settings)` marks it stale. */
    fun enter(app: AppModel) {
        if (v == null && app.settings.isNotEmpty()) apply(app.settings)
        call(app, "Settings") { c -> c.settings().let(::apply) }
        loadExtras(app)
    }

    private fun apply(j: JsonObject) {
        project = j["quickLaunchProject"].str.orEmpty()
        hours = workHoursText(j)
        wtLocation = j["worktrees"]["location"].str.orEmpty()
        wtNames = j["worktrees"]["nameInstructions"].str.orEmpty()
        v = j
    }

    /** The side reads behind Maintenance, Remote control and the 5-hour window; a failure leaves a placeholder. */
    fun loadExtras(app: AppModel) {
        val c = app.client ?: return
        quiet { claude = c.claudeInfo() }
        quiet { git = c.gitInfo() }
        quiet { rc = c.remoteControl() }
        quiet { warmup = c.warmupInfo() }
    }

    private fun quiet(block: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    fun save(app: AppModel, key: String, value: JsonElement) {
        v = JsonObject(v.orEmpty() + (key to value))
        call(app, "Settings") {
            it.saveSetting(key, value)
            app.reloadSettings()
        }
    }

    fun save(app: AppModel, key: String, value: String) = save(app, key, JsonPrimitive(value))

    fun save(app: AppModel, key: String, value: Boolean) = save(app, key, JsonPrimitive(value))

    fun saveNested(app: AppModel, key: String, field: String, value: JsonElement) = save(app, key, withNested(v, key, field, value))

    fun saveNested(app: AppModel, key: String, field: String, value: Any) = saveNested(
        app, key, field,
        when (value) {
            is Boolean -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            else -> JsonPrimitive(value.toString())
        },
    )

    fun toggleInList(app: AppModel, key: String, item: String) = save(app, key, jsonStrings(toggled(strList(setting(key)), item)))

    fun saveProject(app: AppModel) {
        save(app, "quickLaunchProject", project.trim())
        app.say("✓ Saved")
    }

    fun saveHours(app: AppModel) {
        val slots = parseWorkHours(hours) ?: return app.say("✗ Working hours look like 09:00-12:00, 14:00-18:00")
        saveNested(app, "warmup", "workHours", slots)
        app.say("✓ Saved")
    }

    fun saveWtText(app: AppModel, field: String) {
        saveNested(app, "worktrees", field, (if (field == "location") wtLocation else wtNames).trim())
        app.say("✓ Saved")
    }

    fun saveWtCleanup(app: AppModel, field: String, value: JsonElement) {
        val rules = JsonObject(setting("worktrees")["cleanup"].obj.orEmpty() + (field to value))
        saveNested(app, "worktrees", "cleanup", rules)
    }

    /** A server call that holds the page's busy flag, flashes its outcome, then rereads the extras. */
    private fun action(app: AppModel, key: String, block: suspend (HookedClient) -> String, failure: String) {
        val c = app.client ?: return
        busy = key
        viewModelScope.launch {
            try {
                app.say(block(c))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.say("✗ $failure: ${e.message}")
            } finally {
                busy = null
            }
            loadExtras(app)
        }
    }

    fun runWarmup(app: AppModel) = action(app, "warmup", { it.runWarmup(); "✓ Warm-up ping sent" }, "Warm-up")

    fun resync(app: AppModel) = action(app, "resync", { it.resyncStates(); "✓ Live states resynced" }, "Live states resynced")

    fun upgrade(app: AppModel) = action(app, "upgrade", { it.upgradeClaude(); "✓ Claude Code upgraded" }, "Claude Code upgraded")

    fun cleanup(app: AppModel) = action(app, "wt-cleanup", { c ->
        val r = c.cleanupWorktrees()
        wtCleanup = r
        val n = r["removed"].arr.size
        "✓ $n worktree${if (n == 1) "" else "s"} removed"
    }, "Cleanup")

    fun pull(app: AppModel) = action(app, "wt-pull", { c ->
        val r = c.pullCheckouts()
        wtPull = r
        val n = r["checkouts"].arr.count { it["result"].str == "pulled" }
        "✓ $n checkout${if (n == 1) "" else "s"} pulled"
    }, "Pull")

    fun checkout(app: AppModel, branch: String, strategy: String) {
        val c = app.client ?: return
        busy = "checkout"
        viewModelScope.launch {
            try {
                val r = c.checkoutBranch(branch, strategy)
                checkoutDirty = null
                branchesOpen = false
                app.say("✓ On $branch" + (r["stashRef"].str?.let { " (stashed: $it)" } ?: ""))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e.message.orEmpty().contains("uncommitted")) checkoutDirty = branch else app.say("✗ Checkout: ${e.message}")
            } finally {
                busy = null
            }
            loadExtras(app)
        }
    }

    fun renameTag(app: AppModel) {
        val (old, typed) = tagEdit ?: return
        tagEdit = null
        val new = cleanTag(typed)
        if (new.isEmpty() || new == old) return
        retagAll(app, old, new)
    }

    fun deleteTag(app: AppModel, tag: String) = retagAll(app, tag, null)

    /** Tags only exist on sessions, so a rename or delete rewrites every session's list from a fresh read. */
    private fun retagAll(app: AppModel, old: String, new: String?) {
        val hue = app.prefs.tagColors[old]
        app.prefs.tagColor(old, null)
        if (new != null && hue != null) app.prefs.tagColor(new, hue)
        app.tagFilter = app.tagFilter - old
        localTags = retag(localTags ?: app.tags, old, new)
        val c = app.client ?: return
        viewModelScope.launch {
            try {
                c.replaceTags(retag(c.tagMap(), old, new))
                app.say("✓ Tags updated")
                app.refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.say("✗ Tags: ${e.message}")
            }
            localTags = null
        }
    }
}

private data class Section(val key: String, val label: String, val icon: ImageVector)

private val SECTIONS = listOf(
    Section("set-app", "This app", Lucide.Monitor),
    Section("set-sessions", "New sessions", Lucide.Plus),
    Section("set-display", "Sidebar and session", Lucide.Sidebar),
    Section("set-service", "hooked service", Lucide.Activity),
    Section("set-worktrees", "Worktrees", Lucide.GitBranch),
    Section("set-tags", "Tags", Lucide.Tag),
    Section("set-rc", "Remote control", Lucide.Plug),
    Section("set-term", "Terminal", Lucide.Terminal),
    Section("set-keys", "Keyboard shortcuts", Lucide.Zap),
    Section("set-maint", "Maintenance", Lucide.Tool),
    Section("set-flags", "Feature flags", Lucide.Sparkle),
)

private val PAD = 24.dp
private val GAP = 18.dp
private val ACTIVE_BAND = 64.dp
private val TOC_MIN_W = 900.dp

/** rune's Settings page: every card of `view/settings.rs`, plus the tablet's server, scale and notifications. */
@Composable
fun SettingsPage(app: AppModel, requestNotifications: () -> Unit) {
    val m: SettingsModel = viewModel()
    LaunchedEffect(Unit) { m.enter(app) }
    val uri = LocalUriHandler.current
    PageFrame(
        "Settings",
        actions = {
            KButton(
                "Open the web settings",
                { app.config?.base?.let { runCatching { uri.openUri("$it/settings") } } },
                variant = Variant.GHOST_MUTED, size = Size.REGULAR, icon = Lucide.Link,
            )
        },
    ) {
        val v = m.v
        if (v == null) PageLoading() else SettingsBody(app, m, requestNotifications)
    }
}

@Composable
private fun SettingsBody(app: AppModel, m: SettingsModel, requestNotifications: () -> Unit) {
    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val tops = remember { mutableStateListOf<Float>().apply { repeat(SECTIONS.size) { add(Float.MAX_VALUE) } } }
    var viewTop by remember { mutableFloatStateOf(0f) }
    var viewH by remember { mutableFloatStateOf(0f) }
    var lastH by remember { mutableFloatStateOf(0f) }
    val band = with(density) { ACTIVE_BAND.toPx() }
    val active by remember { derivedStateOf { tops.indexOfLast { it <= scroll.value + band }.coerceAtLeast(0) } }
    val cards: List<@Composable () -> Unit> = listOf(
        { AppCard(app, m, requestNotifications) },
        { SessionsCard(app, m) },
        { SidebarCard(app, m) },
        { ServiceCard(app, m) },
        { WorktreesCard(app, m) },
        { TagsCard(app, m) },
        { RemoteCard(app, m) },
        { TerminalCard(app) },
        { ShortcutsCard() },
        { MaintenanceCard(app, m) },
        { FlagsCard(app, m) },
    )
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val toc = maxWidth >= TOC_MIN_W
        Row(Modifier.fillMaxSize()) {
            if (toc) {
                Toc(active) { i ->
                    val target = tops[i]
                    if (target != Float.MAX_VALUE) scope.launch { scroll.animateScrollTo((target - with(density) { PAD.toPx() }).toInt().coerceAtLeast(0)) }
                }
            }
            Column(
                Modifier.weight(1f).fillMaxHeight()
                    .onGloballyPositioned {
                        viewTop = it.positionInRoot().y
                        viewH = it.size.height.toFloat()
                    }
                    .verticalScroll(scroll),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(Modifier.widthIn(max = 860.dp).fillMaxWidth().padding(PAD), verticalArrangement = Arrangement.spacedBy(GAP)) {
                    cards.forEachIndexed { i, card ->
                        Box(
                            Modifier.fillMaxWidth().onGloballyPositioned {
                                val y = it.positionInRoot().y - viewTop + scroll.value
                                if (tops[i] != y) tops[i] = y
                                if (i == cards.lastIndex) lastH = it.size.height.toFloat()
                            },
                        ) { card() }
                    }
                    // Lets the last card scroll up to the top, so its TOC entry can light up.
                    val tail = with(density) { (viewH - lastH - (PAD * 2 + GAP).toPx()).coerceAtLeast(0f).toDp() }
                    Spacer(Modifier.height(tail))
                }
            }
        }
    }
}

@Composable
private fun Toc(active: Int, onPick: (Int) -> Unit) {
    Column(
        Modifier.width(220.dp).fillMaxHeight().background(k.c.bg).endRule(k.c.border).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Box(Modifier.height(26.dp).padding(horizontal = 8.dp), contentAlignment = Alignment.CenterStart) { SectionTitle("ON THIS PAGE") }
        SECTIONS.forEachIndexed { i, s ->
            val on = i == active
            Pressable({ onPick(i) }, Modifier.fillMaxWidth().height(30.dp), fill = if (on) k.c.chip else Color.Transparent) {
                Spacer(Modifier.width(8.dp))
                KIcon(s.icon, if (on) k.c.fg else k.c.muted, 14.dp)
                Spacer(Modifier.width(8.dp))
                Text(s.label, style = if (on) k.ty.uiMedium else k.ty.ui, color = if (on) k.c.fg else k.c.muted, maxLines = 1)
            }
        }
    }
}

// rune's settings rows (`card`, `line`, `block`, `chip`, `toggle`, `stepper`).

internal fun Modifier.topRule(color: Color) = drawBehind {
    drawLine(color, Offset(0f, 0.5f), Offset(size.width, 0.5f), 1.dp.toPx())
}

@Composable
internal fun SetCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(k.r.lg)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(k.c.surface).border(1.dp, k.c.border, shape).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Box(Modifier.padding(bottom = 6.dp)) { SectionTitle(title) }
        content()
    }
}

/** Title and hint on the left, the control on the right; a toggle row toggles from anywhere on it. */
@Composable
internal fun SetLine(title: String, hint: String = "", onClick: (() -> Unit)? = null, control: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val maxControl: Dp = maxWidth * 0.6f
        Row(
            Modifier.fillMaxWidth().topRule(k.c.border)
                .then(if (onClick != null) Modifier.clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClick) else Modifier)
                .padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = k.ty.uiMedium, color = k.c.fg)
                if (hint.isNotEmpty()) Text(hint, style = k.ty.textSmall, color = k.c.faint)
            }
            Box(Modifier.widthIn(max = maxControl)) { control() }
        }
    }
}

/** A stacked setting: the controls get a full-width row under the title. */
@Composable
internal fun SetBlock(title: String, hint: String = "", control: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().topRule(k.c.border).padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = k.ty.uiMedium, color = k.c.fg)
        if (hint.isNotEmpty()) Text(hint, style = k.ty.textSmall, color = k.c.faint)
        control()
    }
}

@Composable
internal fun SetToggle(title: String, hint: String, on: Boolean, onToggle: () -> Unit) =
    SetLine(title, hint, onClick = onToggle) { PageSwitch(on, onToggle) }

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun Chips(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
}

/** A chip with a colour dot, for the schemes. */
@Composable
internal fun SwatchChip(label: String, swatch: Color, on: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(k.r.sm)
    Row(
        Modifier.height(26.dp).clip(shape).background(if (on) k.c.chip else Color.Transparent).border(1.dp, if (on) k.c.accent else k.c.border, shape)
            .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClick).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(swatch))
        Text(label, style = k.ty.textSmallMedium, color = if (on) k.c.fg else k.c.muted, maxLines = 1)
    }
}

@Composable
internal fun Stepper(value: String, minus: () -> Unit, plus: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        KIconButton(Lucide.Minus, "Less", minus, variant = Variant.GHOST_MUTED, size = Size.LARGE)
        Text(value, style = k.ty.uiMedium, color = k.c.fg, textAlign = TextAlign.Center, modifier = Modifier.width(64.dp))
        KIconButton(Lucide.Plus, "More", plus, variant = Variant.GHOST_MUTED, size = Size.LARGE)
    }
}

/** The outcome lines of a clean-up or pull, warnings in the warning ink. */
@Composable
internal fun Report(lines: List<Pair<String, Boolean>>) {
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        lines.forEach { (t, warn) -> Text(t, style = k.ty.textSmall, color = if (warn) k.c.warning.fg else k.c.muted) }
    }
}
