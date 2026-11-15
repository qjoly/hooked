package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.LAUNCH_MODES
import dev.qjoly.hooked.data.LaunchRequest
import dev.qjoly.hooked.data.PermissionMode
import dev.qjoly.hooked.data.appendPrompt
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.boolOr
import dev.qjoly.hooked.data.fableNotice
import dev.qjoly.hooked.data.fableSpent
import dev.qjoly.hooked.data.filterProjects
import dev.qjoly.hooked.data.folderHueIndex
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.initialMode
import dev.qjoly.hooked.data.jsonStrings
import dev.qjoly.hooked.data.launchProjects
import dev.qjoly.hooked.data.launchSession
import dev.qjoly.hooked.data.newFallback
import dev.qjoly.hooked.data.promptLibrary
import dev.qjoly.hooked.data.saveSetting
import dev.qjoly.hooked.data.SeenProject
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.strList
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.data.toggled
import dev.qjoly.hooked.data.usageRaw
import dev.qjoly.hooked.data.visibleModels
import dev.qjoly.hooked.data.worktreeBases
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.Page
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.KMenu
import dev.qjoly.hooked.ui.kit.KMenuItem
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.pages.PageChip
import dev.qjoly.hooked.ui.pages.PageModel
import dev.qjoly.hooked.ui.pages.PageSwitch
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/** The New session form, kept across visits like rune's `new_*` fields. */
class NewSessionModel : PageModel() {
    var project by mutableStateOf("")
    var custom by mutableStateOf(false)
    var search by mutableStateOf("")
    var prompt by mutableStateOf(TextFieldValue(""))
    var model by mutableStateOf<String?>(null)
    var effort by mutableStateOf<String?>(null)
    var mode by mutableStateOf("default")
    var worktree by mutableStateOf(false)
    var wtBase by mutableStateOf("")
    var wtBranch by mutableStateOf("")
    var bases by mutableStateOf<JsonElement?>(null)
        private set
    var basesError by mutableStateOf<String?>(null)
        private set
    var ephemeral by mutableStateOf(false)
    var incognito by mutableStateOf(false)
    var sending by mutableStateOf(false)
        private set
    var usage by mutableStateOf<JsonElement?>(null)
        private set

    /** Favourites as toggled here, ahead of the settings reload. */
    var favs by mutableStateOf<List<String>?>(null)
        private set

    /** The pickers are seeded once from the settings, as rune does at startup, unless already touched. */
    private var seeded = false
    var touched = false
    private var basesJob: Job? = null

    /** rune's `go_new`: a fresh draft in the given project, else the default one, else the last session's. */
    fun enter(app: AppModel) {
        custom = false
        search = ""
        prompt = TextFieldValue("")
        favs = null
        incognito = app.prefs.incognito
        (app.newSessionProject ?: app.settings["quickLaunchProject"].text ?: app.session(app.lastSession)?.project)?.let { project = it }
        val c = app.client ?: return
        viewModelScope.launch {
            try {
                val s = app.settings.takeIf { it.isNotEmpty() } ?: c.settings()
                if (!seeded && !touched) {
                    seeded = true
                    model = s["defaultModel"].text
                    effort = s["defaultEffort"].text
                    val claude = if (s["defaultMode"].text == null) runCatching { c.defaults().mode }.getOrNull() else null
                    mode = initialMode(s, claude)
                }
                if (project.isEmpty()) s["quickLaunchProject"].text?.let { project = it }
                val u = c.usageRaw()
                usage = u
                if (newFallback(s["defaultModel"].text, u)) model = "opus"
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    fun favorites(app: AppModel): List<String> = favs ?: strList(app.settings["favoriteProjects"])

    fun toggleFavorite(app: AppModel, path: String) {
        val next = toggled(favorites(app), path)
        favs = next
        call(app, "Settings") {
            it.saveSetting("favoriteProjects", jsonStrings(next))
            app.reloadSettings()
        }
    }

    fun addPrompt(text: String) {
        val next = appendPrompt(prompt.text, text)
        prompt = TextFieldValue(next, TextRange(next.length))
    }

    /** The bases a worktree can start from, for an absolute folder; outside git, the server's error. */
    fun loadBases(app: AppModel) {
        basesJob?.cancel()
        bases = null
        basesError = null
        val dir = project.trim()
        val c = app.client ?: return
        if (!worktree || !dir.startsWith("/")) return
        basesJob = viewModelScope.launch {
            // Typing a path refetches; wait for a pause.
            delay(300)
            try {
                bases = c.worktreeBases(dir)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                basesError = e.message ?: "not a git repository"
            }
        }
    }

    fun launch(app: AppModel) {
        val cwd = project.trim()
        if (cwd.isEmpty()) return app.say("✗ Pick a project folder first")
        if (sending) return
        val c = app.client ?: return
        val req = LaunchRequest(cwd, prompt.text.trim(), model, effort, mode, incognito, worktree, wtBase, wtBranch, ephemeral)
        sending = true
        viewModelScope.launch {
            try {
                val id = c.launchSession(req)
                app.say("✓ Session launched")
                app.refresh()
                app.open(id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.say("✗ Launch: ${e.message}")
            } finally {
                sending = false
            }
        }
    }
}

/** The page width from which options sit beside the project list (rune: a 1000 pt window, sidebar included). */
private val SIDE_BY_SIDE_MIN_W = 760.dp
private val OPTIONS_W = 320.dp

/** rune's New session page: prompt, saved prompts, model / effort / mode, options, then the project picker. */
@Composable
fun NewSessionPage(app: AppModel) {
    val m: NewSessionModel = viewModel()
    LaunchedEffect(Unit) { m.enter(app) }
    LaunchedEffect(m.project, m.worktree) { m.loadBases(app) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val side = maxWidth >= SIDE_BY_SIDE_MIN_W
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(
                Modifier.widthIn(max = if (side) 1080.dp else 820.dp).fillMaxWidth().padding(28.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Header(app)
                PromptArea(m) { m.launch(app) }
                PromptPills(app, m)
                FableNotice(app, m)
                LaunchRow(app, m)
                if (side) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                        Box(Modifier.weight(1f)) { ProjectColumn(app, m) }
                        Box(Modifier.width(OPTIONS_W)) { Controls(app, m) }
                    }
                } else {
                    Controls(app, m)
                    ProjectColumn(app, m)
                }
            }
        }
    }
}

@Composable
private fun Header(app: AppModel) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        KIconButton(Lucide.ArrowLeft, "Back", { app.openDeck() }, variant = Variant.GHOST_MUTED, size = Size.LARGE)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("New session", style = k.ty.bodyMedium, color = k.c.fg)
            Text("Launches a Claude Code session driven by hooked.", style = k.ty.textSmall, color = k.c.faint)
        }
    }
}

/** rune-kit's TextArea with `auto_grow(4, 16)`; ⌘↵ or Ctrl+↵ launches. */
@Composable
private fun PromptArea(m: NewSessionModel, onLaunch: () -> Unit) {
    val shape = RoundedCornerShape(k.r.md)
    val style = k.ty.ui
    val line = 20.dp
    BasicTextField(
        value = m.prompt,
        onValueChange = { m.prompt = it },
        textStyle = style.copy(color = k.c.fg),
        cursorBrush = SolidColor(k.c.accent),
        minLines = 4,
        maxLines = 16,
        modifier = Modifier.fillMaxWidth().heightIn(min = line * 4 + 12.dp, max = line * 16 + 12.dp)
            .onPreviewKeyEvent { e ->
                if (e.key != Key.Enter || !(e.isCtrlPressed || e.isMetaPressed)) return@onPreviewKeyEvent false
                if (e.type == KeyEventType.KeyDown) onLaunch()
                true
            },
        decorationBox = { inner ->
            Box(Modifier.clip(shape).background(k.c.bg).border(1.dp, k.c.border, shape).padding(horizontal = 8.dp, vertical = 6.dp)) {
                if (m.prompt.text.isEmpty()) Text("What should Claude do? (⌘↵ to launch)", style = style, color = k.c.faint)
                inner()
            }
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PromptPills(app: AppModel, m: NewSessionModel) {
    val list = promptLibrary(app.settings)
    if (list.isEmpty()) return
    FlowRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        SectionTitle("PROMPTS")
        list.forEach { p -> PageChip(p.name, false) { m.addPrompt(p.text) } }
        KButton("Manage", { app.page = Page.Prompts }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
    }
}

@Composable
private fun FableNotice(app: AppModel, m: NewSessionModel) {
    if (!newFallback(app.settings["defaultModel"].str, m.usage)) return
    val shape = RoundedCornerShape(k.r.md)
    Box(Modifier.fillMaxWidth().clip(shape).background(k.c.warning.bg).border(1.dp, k.c.warning.border, shape).padding(10.dp)) {
        Text(fableNotice(fableSpent(m.usage)), style = k.ty.textSmall, color = k.c.warning.fg)
    }
}

@Composable
private fun LaunchRow(app: AppModel, m: NewSessionModel) {
    val project = m.project.trim()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            if (project.isEmpty()) "Pick a project" else "in $project",
            style = k.ty.textSmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        KButton("Cancel", { app.openDeck() }, variant = Variant.GHOST_MUTED, size = Size.LARGE)
        KButton(
            if (m.sending) "Launching…" else "Launch", { m.launch(app) },
            variant = Variant.CONTRAST, size = Size.LARGE, icon = Lucide.Play, enabled = !m.sending && project.isNotEmpty(),
        )
    }
}

@Composable
private fun Labelled(label: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionTitle(label)
        content()
    }
}

@Composable
private fun Controls(app: AppModel, m: NewSessionModel) {
    fun pick(f: () -> Unit) {
        m.touched = true
        f()
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Labelled("MODEL") {
            Chips {
                PageChip("Default", m.model == null) { pick { m.model = null } }
                visibleModels(app.capabilities, app.settings).forEach { o -> PageChip(o.label, m.model == o.id) { pick { m.model = o.id } } }
            }
        }
        Labelled("EFFORT") {
            Chips {
                PageChip("Default", m.effort == null) { pick { m.effort = null } }
                app.capabilities.efforts.forEach { e -> PageChip(e, m.effort == e) { pick { m.effort = e } } }
            }
        }
        Labelled("MODE") {
            Chips { LAUNCH_MODES.forEach { md -> PageChip(PermissionMode.label(md), m.mode == md) { pick { m.mode = md } } } }
        }
        Labelled("OPTIONS") {
            Chips {
                PageChip("Git worktree", m.worktree) { m.worktree = !m.worktree }
                PageChip("Ephemeral", m.ephemeral) { m.ephemeral = !m.ephemeral }
                PageChip("Incognito", m.incognito) { m.incognito = !m.incognito }
            }
        }
        if (m.worktree) WorktreeFields(app, m)
    }
}

/** The web's worktree spec: a base to branch from and an optional branch name. */
@Composable
private fun WorktreeFields(app: AppModel, m: NewSessionModel) {
    val autoName = app.settings["worktrees"]["autoName"].boolOr(true)
    val branches = m.bases["branches"].arr.mapNotNull { it.str }
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("from", style = k.ty.textSmall, color = k.c.muted, modifier = Modifier.width(48.dp))
            KTextInput(m.wtBase, { m.wtBase = it }, m.bases["defaultBase"].str ?: "default branch", Modifier.weight(1f))
            Box {
                KIconButton(Lucide.ChevronDown, "Pick a base", { open = true }, variant = Variant.GHOST_MUTED, size = Size.LARGE, enabled = branches.isNotEmpty())
                KMenu(open, { open = false }, minWidth = 240.dp) {
                    branches.take(40).forEach { b ->
                        KMenuItem(b, {
                            m.wtBase = b
                            open = false
                        }, checked = m.wtBase == b)
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("branch", style = k.ty.textSmall, color = k.c.muted, modifier = Modifier.width(48.dp))
            KTextInput(m.wtBranch, { m.wtBranch = it }, if (autoName) "named from the prompt" else "hooked/<random hex>", Modifier.weight(1f))
        }
        m.basesError?.let { Text(it, style = k.ty.textSmall, color = k.c.warning.fg) }
    }
}

@Composable
private fun ProjectColumn(app: AppModel, m: NewSessionModel) {
    val collapse = app.prefs.collapseWorktrees
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionTitle("PROJECT")
            Spacer(Modifier.weight(1f))
            PageSwitch(collapse, { app.prefs.collapseWorktrees(!collapse) }, label = "Collapse worktrees")
        }
        KTextInput(m.search, { m.search = it }, "Search a project…", Modifier.fillMaxWidth(), leading = { KIcon(Lucide.Search, k.c.faint, 14.dp) })
        ProjectList(app, m, collapse)
    }
}

@Composable
private fun ProjectList(app: AppModel, m: NewSessionModel, collapse: Boolean) {
    val seen = app.visible.map { SeenProject(it.project, it.worktreeOf, it.lastActivity) }
    val hits = filterProjects(launchProjects(m.favorites(app), seen, collapse), m.search)
    val current = m.project.trim()
    val hues = listOf(k.c.accent, k.c.info.hue, k.c.success.hue, k.c.warning.hue, k.c.danger.hue)
    val focus = remember { FocusRequester() }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        hits.forEach { (path, fav) ->
            val hue = hues[folderHueIndex(path)]
            ProjectRow(
                on = !m.custom && current == path,
                onClick = {
                    m.custom = false
                    m.project = path
                },
                badge = { Box(Modifier.size(26.dp).clip(RoundedCornerShape(k.r.sm)).background(hue.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) { KIcon(Lucide.Folder, hue, 14.dp) } },
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(path.substringAfterLast('/'), style = k.ty.uiMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(path, style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                KIconButton(
                    Lucide.Star, if (fav) "Remove from favorites" else "Add to favorites", { m.toggleFavorite(app, path) },
                    variant = if (fav) Variant.NEUTRAL else Variant.GHOST_MUTED, size = Size.LARGE,
                )
            }
        }
        ProjectRow(
            on = m.custom,
            onClick = { m.custom = true },
            badge = { Box(Modifier.size(26.dp).clip(RoundedCornerShape(k.r.sm)).background(k.c.chip), contentAlignment = Alignment.Center) { KIcon(Lucide.Plus, k.c.muted, 14.dp) } },
        ) {
            Text("Other folder…", style = k.ty.uiMedium, color = k.c.fg, modifier = Modifier.weight(1f))
        }
        if (m.custom) {
            LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
            KTextInput(
                m.project, { m.project = it }, "/path/to/the/project", Modifier.fillMaxWidth().padding(top = 4.dp).focusRequester(focus),
                leading = { KIcon(Lucide.Folder, k.c.faint, 14.dp) },
            )
        }
    }
}

@Composable
private fun ProjectRow(on: Boolean, onClick: () -> Unit, badge: @Composable () -> Unit, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val shape = RoundedCornerShape(k.r.md)
    Pressable(onClick, Modifier.fillMaxWidth().border(1.dp, if (on) k.c.accent else Color.Transparent, shape), fill = if (on) k.c.chip else Color.Transparent) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            badge()
            content()
        }
    }
}
