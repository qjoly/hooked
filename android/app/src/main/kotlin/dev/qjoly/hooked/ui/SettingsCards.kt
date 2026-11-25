package dev.qjoly.hooked.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import dev.qjoly.hooked.ServerConfig
import dev.qjoly.hooked.data.COMPACT_SIZES
import dev.qjoly.hooked.data.EDITORS
import dev.qjoly.hooked.data.FEATURE_FLAGS
import dev.qjoly.hooked.data.IDLE_DAYS
import dev.qjoly.hooked.data.LAUNCH_MODES
import dev.qjoly.hooked.data.NAV_PAGES
import dev.qjoly.hooked.data.PermissionMode
import dev.qjoly.hooked.data.SESSION_MENU
import dev.qjoly.hooked.data.TAG_HUE_COUNT
import dev.qjoly.hooked.data.WEEK_DAYS
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.boolOr
import dev.qjoly.hooked.data.branchChips
import dev.qjoly.hooked.data.cleanupReport
import dev.qjoly.hooked.data.flatModels
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.hourLabel
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.pullReport
import dev.qjoly.hooked.data.rcStatus
import dev.qjoly.hooked.data.remoteProjects
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.strList
import dev.qjoly.hooked.data.tagCounts
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.data.toggledDay
import dev.qjoly.hooked.data.warmupHint
import dev.qjoly.hooked.data.windowLabel
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.Appearance
import dev.qjoly.hooked.ui.kit.Corners
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Scheme
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.TagPill
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.tagIndex
import dev.qjoly.hooked.ui.pages.PageChip
import dev.qjoly.hooked.ui.pages.PageSwitch
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.roundToInt

// The cards of rune's Settings page, in its order.

private val SCALES = listOf(1f, 1.1f, 1.2f, 1.3f)

/** A one-line field with an explicit Save, since a soft keyboard has no reliable Enter. */
@Composable
private fun FieldSave(value: String, onChange: (String) -> Unit, placeholder: String, width: Dp, onSave: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        KTextInput(value, onChange, placeholder, Modifier.weight(1f, fill = false).width(width), onSubmit = onSave)
        KButton("Save", onSave, variant = Variant.OUTLINE, size = Size.REGULAR)
    }
}

@Composable
internal fun AppCard(app: AppModel, m: SettingsModel, requestNotifications: () -> Unit) {
    val p = app.prefs
    val navOn = strList(m.setting("navTabs"))
    val home = m.setting("defaultPage").str ?: "deck"
    // The Review lens keeps its layout in its own store (`LensPrefs`).
    val ctx = LocalContext.current
    val lens = remember { ctx.getSharedPreferences("hooked-lens", Context.MODE_PRIVATE) }
    var split by remember { mutableStateOf(lens.getBoolean("diffSplit", false)) }
    fun setSplit(on: Boolean) {
        split = on
        lens.edit { putBoolean("diffSplit", on) }
    }
    SetCard("THIS APP") {
        SetLine("Theme", "Follows the system unless forced.") {
            Chips { Appearance.entries.forEach { a -> PageChip(a.label, p.appearance == a) { p.appearance(a) } } }
        }
        SetLine(
            "Color scheme",
            "Palette used for both light and dark. Coffee is the default; Indigo the previous one; Legacy warm cream and terracotta; Datadog a cool purple console with tight corners; Gruvbox the retro editor palette; Claude the Claude Desktop look.",
        ) {
            Chips { Scheme.entries.forEach { s -> SwatchChip(s.label, Color(s.swatch), p.scheme == s) { p.scheme(s) } } }
        }
        SetLine("Corners", "Square removes every rounded corner. Combines with any theme and palette.") {
            Chips {
                PageChip("Rounded", p.corners == Corners.ROUND) { p.corners(Corners.ROUND) }
                PageChip("Square", p.corners == Corners.SHARP) { p.corners(Corners.SHARP) }
            }
        }
        SetLine("Interface scale", "Enlarges everything on this tablet, for fingers.") {
            Chips { SCALES.forEach { s -> PageChip("${(s * 100).roundToInt()}%", p.uiScale == s) { p.uiScale(s) } } }
        }
        SetToggle(
            "Notifications",
            "Counts the sessions waiting on you, and notifies when one starts waiting while the app is closed.",
            app.notify,
        ) {
            val on = !app.notify
            app.changeNotify(on)
            if (on) requestNotifications()
        }
        SetBlock("Navigation", "Which pages get a tab in the top bar. The others stay one search away.") {
            Chips { NAV_PAGES.filter { (key, _) -> app.moduleOn(key) }.forEach { (key, label) -> PageChip(label, key in navOn) { m.toggleInList(app, "navTabs", key) } } }
        }
        SetBlock("Default page", "Where the app opens.") {
            Chips { (listOf("deck" to "Deck") + NAV_PAGES.filter { (key, _) -> app.moduleOn(key) }).forEach { (key, label) -> PageChip(label, home == key) { m.save(app, "defaultPage", key) } } }
        }
        SetLine("Review layout", "How the Review lens shows a diff by default.") {
            Chips {
                PageChip("Unified", !split) { setSplit(false) }
                PageChip("Side by side", split) { setSplit(true) }
            }
        }
        ServerBlock(app)
    }
}

/** The tablet's own: which hooked it drives. */
@Composable
private fun ServerBlock(app: AppModel) {
    val saved = app.config
    var host by rememberSaveable { mutableStateOf(saved?.host.orEmpty()) }
    var port by rememberSaveable { mutableStateOf((saved?.port ?: ServerConfig.DEFAULT_PORT).toString()) }
    var https by rememberSaveable { mutableStateOf(saved?.https ?: false) }
    var testing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    SetBlock(
        "Server",
        "The hooked this tablet drives. It has to listen on the network (HOST=0.0.0.0), or be reachable through WireGuard or Tailscale. A pairing link hooked://connect?host=…&port=4123 fills this in.",
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KTextInput(host, { host = it }, "192.168.1.20 or my-mac.tailnet.ts.net", Modifier.weight(1f))
            KTextInput(port, { v -> port = v.filter(Char::isDigit).take(5) }, "4123", Modifier.width(72.dp))
            PageSwitch(https, { https = !https }, label = "HTTPS")
            KButton(
                if (testing) "Testing…" else "Test & save",
                {
                    val cfg = ServerConfig(ServerConfig.cleanHost(host), port.toIntOrNull()?.takeIf { it in 1..65535 } ?: ServerConfig.DEFAULT_PORT, https)
                    testing = true
                    error = null
                    scope.launch {
                        error = app.pair(cfg)
                        testing = false
                        if (error == null) app.say("✓ Connected to ${cfg.base}")
                    }
                },
                variant = Variant.OUTLINE, size = Size.REGULAR, enabled = host.isNotBlank() && !testing,
            )
        }
        error?.let { Text(it, style = k.ty.textSmall, color = k.c.danger.fg) }
    }
}

@Composable
internal fun SessionsCard(app: AppModel, m: SettingsModel) {
    val caps = app.capabilities
    val models = flatModels(caps)
    val hidden = strList(m.setting("hiddenModels"))
    val model = m.setting("defaultModel").str.orEmpty()
    val effort = m.setting("defaultEffort").str.orEmpty()
    val mode = m.setting("defaultMode").str ?: "default"
    val showWork = m.setting("showWork").boolOr(true)
    SetCard("NEW SESSIONS") {
        SetBlock("Default model", "Used when a session is launched without one.") {
            Chips {
                PageChip("Claude's default", model.isEmpty()) { m.save(app, "defaultModel", "") }
                models.filter { it.id !in hidden }.forEach { o -> PageChip(o.label, model == o.id) { m.save(app, "defaultModel", o.id) } }
            }
        }
        SetBlock("Default effort") {
            Chips { caps.efforts.forEach { e -> PageChip(e, effort == e) { m.save(app, "defaultEffort", e) } } }
        }
        SetBlock("Default permission mode", "Also the mode a Resume runs in.") {
            Chips { LAUNCH_MODES.forEach { md -> PageChip(PermissionMode.label(md), mode == md) { m.save(app, "defaultMode", md) } } }
        }
        SetLine("Default project", "Pre-filled in New session.") {
            FieldSave(m.project, { m.project = it }, "/path/to/project", 360.dp) { m.saveProject(app) }
        }
        SetBlock("Visible models", "Which models the pickers offer. The list comes from your installed claude.") {
            Chips { models.forEach { o -> PageChip(o.label, o.id !in hidden) { m.toggleInList(app, "hiddenModels", o.id) } } }
        }
        SetToggle("Show your work", "Ask Claude to narrate its steps between tool calls.", showWork) { m.save(app, "showWork", !showWork) }
    }
}

@Composable
internal fun SidebarCard(app: AppModel, m: SettingsModel) {
    val sc = m.setting("sidebarCache")
    val display = sc["display"].str ?: "badge"
    val window = sc["windowMin"].int ?: 15
    val editor = m.setting("editor").str ?: "vscode"
    val menu = m.setting("statusBar")
    SetCard("SIDEBAR AND SESSION") {
        SetLine("Prompt cache countdown", "Beside each row's age, or instead of it.") {
            Chips {
                PageChip("Beside", display != "replace") { m.saveNested(app, "sidebarCache", "display", "badge") }
                PageChip("Instead", display == "replace") { m.saveNested(app, "sidebarCache", "display", "replace") }
            }
        }
        SetLine("Countdown shows", "Only once the cache has this little left (0 = always).") {
            Stepper(
                windowLabel(window),
                { m.saveNested(app, "sidebarCache", "windowMin", (window - 5).coerceAtLeast(0)) },
                { m.saveNested(app, "sidebarCache", "windowMin", (window + 5).coerceAtMost(60)) },
            )
        }
        SetBlock("Code editor", "Used by Open in editor.") {
            Chips { EDITORS.forEach { (key, label) -> PageChip(label, editor == key) { m.save(app, "editor", key) } } }
        }
        SetBlock("Session menu", "Controls the session header's ⋯ menu shows.") {
            Chips {
                SESSION_MENU.forEach { (key, label) ->
                    val on = menu[key].boolOr(true)
                    PageChip(label, on) { m.saveNested(app, "statusBar", key, !on) }
                }
            }
        }
    }
}

@Composable
internal fun ServiceCard(app: AppModel, m: SettingsModel) {
    val dg = m.setting("digest")
    val dgAuto = dg["auto"].boolOr(true)
    val hour = dg["hour"].int ?: 7
    val ac = m.setting("autoCompact")
    val acOn = ac["enabled"].bool
    val minK = ac["minContextK"].int ?: 100
    val prWatch = m.setting("autoPrWatch").bool
    val wu = m.setting("warmup")
    val wuOn = wu["enabled"].bool
    val days = wu["days"].arr.mapNotNull { it.int }
    val skip = wu["skipIfWeeklyOver"].int ?: 90
    val wuModel = wu["model"].str ?: "haiku"
    SetCard("HOOKED SERVICE") {
        SetToggle("Daily digest", "Writes yesterday's summary every morning.", dgAuto) { m.saveNested(app, "digest", "auto", !dgAuto) }
        SetLine("Digest time", "Hour of the day the digest is written.") {
            Stepper(hourLabel(hour), { m.saveNested(app, "digest", "hour", (hour + 23) % 24) }, { m.saveNested(app, "digest", "hour", (hour + 1) % 24) })
        }
        SetToggle(
            "Auto-compact",
            "Runs /compact on a session waiting for you just before its prompt cache expires. Lossy: earlier turns become a summary.",
            acOn,
        ) { m.saveNested(app, "autoCompact", "enabled", !acOn) }
        SetLine("Only above", "Context size under which a cold resume is cheap anyway.") {
            Chips { COMPACT_SIZES.forEach { n -> PageChip(if (n == 0) "any size" else "${n}k", minK == n) { m.saveNested(app, "autoCompact", "minContextK", n) } } }
        }
        SetToggle(
            "Pull request watch",
            "Wakes a driven session when the open PR you authored that it links last gets failing or passing checks, a merge conflict, or someone else's comment. Each wake is a turn.",
            prWatch,
        ) { m.save(app, "autoPrWatch", !prWatch) }
        SetLine("5-hour window", warmupHint(m.warmup)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KButton("Run now", { m.runWarmup(app) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, enabled = m.busy == null)
                PageSwitch(wuOn, { m.saveNested(app, "warmup", "enabled", !wuOn) })
            }
        }
        SetLine("Working hours", "Slots separated by commas.") {
            FieldSave(m.hours, { m.hours = it }, "09:00-12:00, 14:00-18:00", 320.dp) { m.saveHours(app) }
        }
        SetLine("Days") {
            Chips {
                WEEK_DAYS.forEachIndexed { i, d ->
                    PageChip(d, i in days) { m.saveNested(app, "warmup", "days", JsonArray(toggledDay(days, i).map(::JsonPrimitive))) }
                }
            }
        }
        SetLine("Ping model") {
            Chips { listOf("haiku", "sonnet").forEach { x -> PageChip(x, wuModel == x) { m.saveNested(app, "warmup", "model", x) } } }
        }
        SetLine("Skip above", "No ping once the weekly limit is used this much.") {
            Stepper(
                "$skip%",
                { m.saveNested(app, "warmup", "skipIfWeeklyOver", (skip - 5).coerceAtLeast(0)) },
                { m.saveNested(app, "warmup", "skipIfWeeklyOver", (skip + 5).coerceAtMost(100)) },
            )
        }
    }
}

@Composable
internal fun WorktreesCard(app: AppModel, m: SettingsModel) {
    val wt = m.setting("worktrees")
    val autoName = wt["autoName"].boolOr(true)
    val onArchive = wt["cleanup"]["onArchive"].bool
    val idle = wt["cleanup"]["inactiveDays"].int ?: 0
    val autoPull = m.setting("autoPullProjects").bool
    val busy = m.busy != null
    SetCard("WORKTREES") {
        SetLine("Folder", "Where new worktrees go: an absolute path or ~/path. Existing worktrees stay where they are.") {
            FieldSave(m.wtLocation, { m.wtLocation = it }, "~/.claude/hooked/worktrees", 320.dp) { m.saveWtText(app, "location") }
        }
        SetToggle(
            "Name branches from the first prompt",
            "One Haiku call, e.g. feat/dark-mode-toggle. The session starts on a temporary hooked/… branch, renamed a few seconds later.",
            autoName,
        ) { m.saveNested(app, "worktrees", "autoName", !autoName) }
        SetLine("Naming instructions", "Added to the naming prompt, e.g. prefix with the Jira key when the prompt has one.") {
            FieldSave(m.wtNames, { m.wtNames = it }, "Extra instructions", 320.dp) { m.saveWtText(app, "nameInstructions") }
        }
        SetToggle(
            "Remove once archived",
            "Removes a worktree hooked created once every session in it is archived, a few seconds after the archive. A worktree with uncommitted or untracked files, or a running session, is kept; ignored files (.env, build output) go with it. The branch stays, and resuming a session checks its worktree out again.",
            onArchive,
        ) { m.saveWtCleanup(app, "onArchive", JsonPrimitive(!onArchive)) }
        SetBlock("Remove idle worktrees", "After this long without activity in any of its sessions. Checked hourly.") {
            Chips { IDLE_DAYS.forEach { d -> PageChip(if (d == 0) "Never" else "$d days", idle == d) { m.saveWtCleanup(app, "inactiveDays", JsonPrimitive(d)) } } }
        }
        SetLine("Clean up now", "Runs the rules above once.") {
            KButton("Clean up", { m.cleanup(app) }, variant = Variant.OUTLINE, size = Size.REGULAR, icon = Lucide.Trash, enabled = !busy && (onArchive || idle > 0))
        }
        m.wtCleanup?.let { Report(cleanupReport(it)) }
        SetToggle(
            "Keep main checkouts up to date",
            "Every 10 minutes, fast-forwards the main checkout of each repository used in the last 30 days. Only on its default branch, with no changed or untracked file, no local commit and no running session.",
            autoPull,
        ) { m.save(app, "autoPullProjects", !autoPull) }
        SetLine("Pull now", "Runs the pass once, whether the setting is on or not.") {
            KButton("Pull", { m.pull(app) }, variant = Variant.OUTLINE, size = Size.REGULAR, icon = Lucide.GitBranch, enabled = !busy)
        }
        m.wtPull?.let { Report(pullReport(it)) }
    }
}

@Composable
internal fun TagsCard(app: AppModel, m: SettingsModel) {
    val autoTags = m.setting("autoTags").boolOr(true)
    val prTags = m.setting("autoPrReviewTag").boolOr(true)
    // Incognito must not name the tags of hidden sessions.
    val only = if (app.prefs.incognito) app.visible.map { it.id }.toSet() else null
    val counts = tagCounts(m.localTags ?: app.tags, only)
    SetCard("TAGS") {
        SetToggle("Auto tags", "Tag new sessions from their content (one Haiku call after the first turn).", autoTags) { m.save(app, "autoTags", !autoTags) }
        SetToggle("PR review tags", "Tag a session pr-approved / pr-changes-requested when its pull request gets reviewed.", prTags) {
            m.save(app, "autoPrReviewTag", !prTags)
        }
        counts.forEach { (t, n) ->
            TagRow(app, m, t, n)
            if (m.hueOpen == t) HuePicker(app, t)
        }
    }
}

@Composable
private fun TagRow(app: AppModel, m: SettingsModel, tag: String, n: Int) {
    val picking = m.hueOpen == tag
    val edit = m.tagEdit?.takeIf { it.first == tag }
    val shape = RoundedCornerShape(k.r.sm)
    Row(
        Modifier.fillMaxWidth().topRule(k.c.border).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(20.dp).clip(shape).background(k.c.tagHue(tagIndex(tag, app.prefs.tagColors)))
                .border(if (picking) 2.dp else 1.dp, if (picking) k.c.accent else k.c.border2, shape)
                .clickable(remember { MutableInteractionSource() }, indication = null) { m.hueOpen = if (picking) null else tag },
        )
        if (edit != null) {
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
            KTextInput(edit.second, { m.tagEdit = tag to it }, "Tag name", Modifier.width(220.dp).focusRequester(focus), onSubmit = { m.renameTag(app) })
        } else {
            TagPill(tag, app.prefs.tagColors)
        }
        Text("$n session${if (n == 1) "" else "s"}", style = k.ty.textSmall, color = k.c.faint, maxLines = 1)
        Spacer(Modifier.weight(1f))
        if (edit != null) {
            KButton("Save", { m.renameTag(app) }, variant = Variant.OUTLINE, size = Size.REGULAR)
            KButton("Cancel", { m.tagEdit = null }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
        } else {
            KButton("Rename", { m.tagEdit = tag to tag }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
            KButton("Delete", { m.deleteTag(app, tag) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HuePicker(app: AppModel, tag: String) {
    val picked = app.prefs.tagColors[tag]
    val shape = RoundedCornerShape(k.r.sm)
    FlowRow(
        Modifier.fillMaxWidth().padding(start = 30.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (i in 0 until TAG_HUE_COUNT) {
            val hue = k.c.tagHue(i)
            val on = picked == i
            Box(
                Modifier.height(26.dp).clip(shape).background(hue.copy(alpha = 0.14f))
                    .border(if (on) 2.dp else 1.dp, if (on) hue else hue.copy(alpha = 0.35f), shape)
                    .clickable(remember { MutableInteractionSource() }, indication = null) { app.prefs.tagColor(tag, i) }
                    .padding(horizontal = 7.dp),
                contentAlignment = Alignment.Center,
            ) { Text("#$tag", style = k.ty.textXsmallMedium, color = hue, maxLines = 1) }
        }
        KButton("Auto", { app.prefs.tagColor(tag, null) }, variant = if (picked == null) Variant.OUTLINE else Variant.GHOST_MUTED, size = Size.REGULAR)
    }
}

@Composable
internal fun RemoteCard(app: AppModel, m: SettingsModel) {
    val on = strList(m.setting("remoteControlProjects"))
    val projects = remoteProjects(m.v, app.visible.mapNotNull { it.project }.distinct())
    SetCard("REMOTE CONTROL") {
        SetBlock("Projects", "hooked keeps a claude remote-control server running for these, so each shows up as an environment in the Claude app.") {
            Chips {
                projects.forEach { p ->
                    val name = p.substringAfterLast('/')
                    val st = rcStatus(m.rc, p)
                    PageChip(if (p in on && st.isNotEmpty()) "$name · $st" else name, p in on) { m.toggleInList(app, "remoteControlProjects", p) }
                }
            }
        }
    }
}

@Composable
internal fun TerminalCard(app: AppModel) {
    val size = app.prefs.termFont
    SetCard("TERMINAL") {
        SetLine("Font size", "The terminal panel's text size on this tablet.") {
            Stepper("${size.roundToInt()} pt", { app.prefs.termFont(size - 1) }, { app.prefs.termFont(size + 1) })
        }
    }
}

/** The keys this app answers to; rune's recorder has nothing to record on a tablet. */
private val SHORTCUTS = listOf(
    "Converse lens" to "⌘1",
    "Toggle terminal panel" to "⌘2",
    "Review lens" to "⌘3",
    "MCP lens" to "⌘4",
    "Trace lens" to "⌘5",
    "Send the message" to "↵",
    "New line in the message" to "⇧↵",
    "Interrupt Claude" to "Esc",
    "Launch from New session" to "⌘↵",
)

@Composable
internal fun ShortcutsCard() {
    SetCard("KEYBOARD SHORTCUTS") {
        Text("With a hardware keyboard. Ctrl works wherever ⌘ is shown.", style = k.ty.textSmall, color = k.c.faint, modifier = Modifier.padding(bottom = 6.dp))
        SHORTCUTS.forEach { (label, keys) -> SetLine(label) { Kbd(keys) } }
    }
}

@Composable
private fun Kbd(keys: String) {
    val shape = RoundedCornerShape(k.r.sm)
    Box(
        Modifier.height(22.dp).clip(shape).background(k.c.chip).border(1.dp, k.c.border, shape).padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) { Text(keys, style = k.ty.mono, color = k.c.fg, maxLines = 1) }
}

@Composable
internal fun MaintenanceCard(app: AppModel, m: SettingsModel) {
    val installed = m.claude["installed"].str ?: "…"
    val method = m.claude["install"]["label"].str.orEmpty()
    val canUpgrade = m.claude["install"]["upgrade"].text != null
    val branch = m.git["current"].str ?: "…"
    val ahead = m.git["ahead"].int ?: 0
    val behind = m.git["behind"].int ?: 0
    val gitSync = m.setting("autoGitSync").bool
    val restart = m.setting("gitAutoRestartOnLock").bool
    val busy = m.busy != null
    SetCard("MAINTENANCE") {
        SetLine("Live state", "Recompute every session's state now, to fix one stuck on working after it finished.") {
            KButton("Resync", { m.resync(app) }, variant = Variant.OUTLINE, size = Size.REGULAR, icon = Lucide.Restart, enabled = !busy)
        }
        SetLine(
            "Claude Code $installed",
            (if (method.isEmpty()) "" else "Installed through $method. ") + "Running sessions keep their version until they restart.",
        ) {
            KButton("Upgrade", { m.upgrade(app) }, variant = Variant.OUTLINE, size = Size.REGULAR, enabled = !busy && canUpgrade)
        }
        SetLine("hooked on $branch", "$ahead ahead, $behind behind its upstream.") {
            KButton(if (m.branchesOpen) "Close" else "Switch branch…", { m.branchesOpen = !m.branchesOpen }, variant = Variant.OUTLINE, size = Size.REGULAR)
        }
        if (m.branchesOpen) Branches(app, m)
        SetToggle("Auto git sync", "Keep hooked's own checkout up to date with its remote.", gitSync) { m.save(app, "autoGitSync", !gitSync) }
        SetToggle("Restart after an update", "Restart hooked by itself when a sync pulled changes and nothing is running.", restart) {
            m.save(app, "gitAutoRestartOnLock", !restart)
        }
    }
}

@Composable
private fun Branches(app: AppModel, m: SettingsModel) {
    val busy = m.busy != null
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        m.checkoutDirty?.let { b ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("The working tree is dirty: choose how to proceed.", style = k.ty.textSmall, color = k.c.warning.fg, modifier = Modifier.weight(1f, fill = false))
                KButton("Stash & checkout", { m.checkout(app, b, "stash") }, variant = Variant.OUTLINE, size = Size.REGULAR, enabled = !busy)
                KButton("Force (drop changes)", { m.checkout(app, b, "force") }, variant = Variant.DANGER, size = Size.REGULAR, enabled = !busy)
            }
        }
        Chips { branchChips(m.git).forEach { b -> PageChip(b.label, b.current) { if (!b.current) m.checkout(app, b.name, "block") } } }
    }
}

@Composable
internal fun FlagsCard(app: AppModel, m: SettingsModel) {
    val flags = m.setting("featureFlags")
    SetCard("FEATURE FLAGS") {
        FEATURE_FLAGS.forEach { f ->
            val on = flags[f.key].bool
            SetToggle(f.title, f.hint, on) { m.saveNested(app, "featureFlags", f.key, !on) }
        }
    }
}
