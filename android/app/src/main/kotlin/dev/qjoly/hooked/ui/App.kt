package dev.qjoly.hooked.ui

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.qjoly.hooked.R
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.body
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.state.Page
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.state.costLabel
import dev.qjoly.hooked.state.projectLabel
import dev.qjoly.hooked.ui.kit.Appearance
import dev.qjoly.hooked.ui.kit.Corners
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Scheme
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.rememberKit
import kotlinx.serialization.json.JsonElement
import dev.qjoly.hooked.ServerConfig
import dev.qjoly.hooked.data.Gauge
import dev.qjoly.hooked.data.PermissionMode
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.state.AppModel
import kotlinx.coroutines.launch

@Composable
fun HookedApp(app: AppModel, requestNotifications: () -> Unit) {
    val kit = rememberKit(app.prefs.scheme, app.prefs.appearance, app.prefs.corners)
    val density = LocalDensity.current
    // The status and navigation bar icons follow the app's appearance, not the system's.
    val view = LocalView.current
    SideEffect {
        (view.context as? Activity)?.window?.let { w ->
            WindowCompat.getInsetsController(w, view).run {
                isAppearanceLightStatusBars = !kit.dark
                isAppearanceLightNavigationBars = !kit.dark
            }
        }
    }
    // 1 pt on the desktop is 1 dp here; the interface scale enlarges everything for fingers.
    CompositionLocalProvider(LocalDensity provides Density(density.density * app.prefs.uiScale, density.fontScale)) {
        HookedTheme(kit) {
            Surface(Modifier.fillMaxSize(), color = k.c.bg) {
                if (app.config == null) ConnectScreen(app) else Shell(app, requestNotifications)
            }
        }
    }
}

@Composable
private fun Shell(app: AppModel, requestNotifications: () -> Unit) {
    var palette by remember { mutableStateOf(false) }
    var account by remember { mutableStateOf(false) }
    var trash by remember { mutableStateOf(false) }
    BackHandler(app.page is Page.Session) { app.openDeck() }
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
        val wide = maxWidth >= 1150.dp
        Column(Modifier.fillMaxSize()) {
            TopBar(app, wide, { palette = true }, { account = true }, { trash = true })
            Row(Modifier.weight(1f).fillMaxWidth()) {
                if (app.prefs.sidebarOpen) Sidebar(app) else Rail(app)
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    when (val p = app.page) {
                        Page.Deck -> DeckScreen(app)
                        is Page.Session -> SessionPane(app, p.id, onBack = null)
                    }
                }
            }
        }
    }
    if (app.showNew) NewSessionDialog(app)
    if (app.showSettings) SettingsDialog(app, requestNotifications)
    if (palette) Palette(app) { palette = false }
    if (account) AccountModal(app) { account = false }
    if (trash) TrashModal(app) { trash = false }
}

/** A first palette: sessions by title, project or branch, and the main commands. */
@Composable
private fun Palette(app: AppModel, close: () -> Unit) {
    val c = k.c
    var q by remember { mutableStateOf("") }
    val needle = q.trim().lowercase()
    val commands = listOf<Pair<String, () -> Unit>>(
        "New session" to { app.newSessionProject = null; app.showNew = true },
        "Go to the Deck" to { app.openDeck() },
        "Settings" to { app.showSettings = true },
        "Toggle the sidebar" to { app.prefs.sidebarOpen(!app.prefs.sidebarOpen) },
    ).filter { needle.isEmpty() || needle in it.first.lowercase() }
    val hits = app.visible.filter { s ->
        needle.isEmpty() || listOfNotNull(app.title(s), s.projectName, s.repo, s.gitBranch).any { needle in it.lowercase() }
    }.take(12)
    KModal(close, "Search, launch, command…", width = 600.dp) {
        KTextInput(q, { q = it }, "Type to search", Modifier.fillMaxWidth(), onSubmit = {
            hits.firstOrNull()?.let { app.open(it.id); close() } ?: commands.firstOrNull()?.let { it.second(); close() }
        }, leading = { KIcon(Lucide.Search, c.muted, 14.dp) })
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (hits.isNotEmpty()) SectionTitle("SESSIONS", Modifier.padding(start = 8.dp, top = 4.dp))
            for (s in hits) {
                Pressable({ app.open(s.id); close() }, Modifier.fillMaxWidth().height(32.dp), radius = k.r.md) {
                    Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Dot(c.stateColor(s.state.name.lowercase()), 7.dp)
                        Text(app.title(s), style = k.ty.ui, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(projectLabel(s), style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                    }
                }
            }
            if (commands.isNotEmpty()) SectionTitle("COMMANDS", Modifier.padding(start = 8.dp, top = 4.dp))
            for ((label, run) in commands) {
                Pressable({ run(); close() }, Modifier.fillMaxWidth().height(32.dp), radius = k.r.md) {
                    Text(label, style = k.ty.ui, color = c.fg, modifier = Modifier.padding(horizontal = 10.dp))
                }
            }
        }
    }
}

@Composable
private fun AccountModal(app: AppModel, close: () -> Unit) {
    val c = k.c
    var info by remember { mutableStateOf<JsonElement?>(null) }
    LaunchedEffect(Unit) { info = runCatching { app.client?.get("api/account") }.getOrNull() }
    KModal(close, "Claude account") {
        val i = info
        Text(i?.get("displayName").text ?: i?.get("email").text ?: "Loading…", style = k.ty.bodyMedium, color = c.fg)
        listOfNotNull(i?.get("email").text, i?.get("organizationName").text, i?.get("subscriptionType").text).forEach {
            Text(it, style = k.ty.textSmall, color = c.muted)
        }
        if (i != null && !i["loggedIn"].bool) Text("Not signed in", style = k.ty.textSmall, color = c.warning.fg)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { KButton("Close", close, variant = Variant.GHOST_MUTED) }
    }
}

/** Deleted sessions: the transcript stays in bin/ and comes back on Restore. */
@Composable
private fun TrashModal(app: AppModel, close: () -> Unit) {
    val c = k.c
    var items by remember { mutableStateOf<List<JsonElement>?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun load() { items = runCatching { app.client?.get("api/trash")?.get("trashed").arr.distinctBy { it["id"].str } }.getOrNull() ?: emptyList() }
    LaunchedEffect(Unit) { load() }
    KModal(close, "Trash") {
        val list = items
        Text(
            when {
                list == null -> "Loading…"
                list.isEmpty() -> "Empty. Deleted sessions land here and stay recoverable."
                else -> "${list.size} session${if (list.size == 1) "" else "s"}: the transcript is kept in bin/, restorable anytime."
            },
            style = k.ty.textSmall, color = c.muted,
        )
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            for (t in list.orEmpty()) {
                val id = t["id"].str ?: continue
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(t["title"].text?.takeIf { it != "(sans titre)" } ?: t["firstPrompt"].text ?: "(untitled)", style = k.ty.ui, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val ago = t["trashedAt"].millis?.let { agoShort(it, app.now) } ?: "—"
                        Text(listOfNotNull(t["projectName"].text, "deleted $ago ago", t["cost"].dbl?.let { costLabel(it) }).joinToString(" · "), style = k.ty.textXsmall, color = c.faint)
                    }
                    KButton(if (busy == id) "Restoring…" else "Restore", {
                        busy = id
                        scope.launch {
                            runCatching { app.client?.post("api/restore", body("id" to id)) }
                            busy = null
                            load()
                            app.refresh()
                        }
                    }, variant = Variant.OUTLINE, enabled = busy == null)
                }
            }
        }
    }
}

/** Host, port and HTTPS, tested before they are saved. */
@Composable
private fun ServerForm(app: AppModel, onSaved: () -> Unit = {}) {
    val saved = app.config
    var host by rememberSaveable { mutableStateOf(saved?.host.orEmpty()) }
    var port by rememberSaveable { mutableStateOf((saved?.port ?: ServerConfig.DEFAULT_PORT).toString()) }
    var https by rememberSaveable { mutableStateOf(saved?.https ?: false) }
    var testing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            host, { host = it }, label = { Text("Host") }, placeholder = { Text("192.168.1.20 or my-mac.tailnet.ts.net") },
            singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            OutlinedTextField(
                port, { port = it.filter(Char::isDigit).take(5) }, label = { Text("Port") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(140.dp),
            )
            Text("HTTPS", color = hooked.ink)
            Switch(https, { https = it })
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                {
                    val cfg = ServerConfig(ServerConfig.cleanHost(host), port.toIntOrNull()?.takeIf { it in 1..65535 } ?: ServerConfig.DEFAULT_PORT, https)
                    testing = true
                    error = null
                    scope.launch {
                        error = app.pair(cfg)
                        testing = false
                        if (error == null) onSaved()
                    }
                },
                enabled = host.isNotBlank() && !testing,
            ) { Text("Test & save") }
            if (testing) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        }
        (error ?: app.message)?.let { Text(it, color = decisionStyle().ink, fontSize = 13.sp) }
    }
}

@Composable
private fun ConnectScreen(app: AppModel) {
    Box(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
        Surface(Modifier.widthIn(max = 560.dp).padding(24.dp), shape = MaterialTheme.shapes.large, color = hooked.card, shadowElevation = 2.dp) {
            Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Logo(emptyList(), 64.dp)
                Text("Connect to hooked", style = MaterialTheme.typography.headlineMedium, color = hooked.ink)
                Text("The tablet drives the Claude Code sessions of the machine that runs hooked.", color = hooked.muted)
                ServerForm(app)
                HorizontalDivider(color = hooked.line)
                Text(
                    "hooked has to listen on the network (HOST=0.0.0.0), or be reachable through WireGuard or Tailscale. " +
                        "A pairing link fills this in: hooked://connect?host=…&port=4123",
                    fontSize = 13.sp, color = hooked.muted,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SettingsDialog(app: AppModel, requestNotifications: () -> Unit) {
    AlertDialog(
        onDismissRequest = { app.showSettings = false },
        title = { Text("Settings") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Text("APPEARANCE", style = k.ty.textXsmallMedium, color = k.c.faint)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Scheme.entries.forEach { sc ->
                        FilterChip(app.prefs.scheme == sc, { app.prefs.scheme(sc) }, { Text(sc.label) }, leadingIcon = { Dot(Color(sc.swatch), 10.dp) })
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Appearance.entries.forEach { ap -> FilterChip(app.prefs.appearance == ap, { app.prefs.appearance(ap) }, { Text(ap.label) }) }
                    Corners.entries.forEach { co -> FilterChip(app.prefs.corners == co, { app.prefs.corners(co) }, { Text(if (co == Corners.ROUND) "Rounded" else "Square") }) }
                }
                Text("Interface scale", style = k.ty.uiMedium, color = k.c.fg)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(1f, 1.1f, 1.2f, 1.3f).forEach { sc -> FilterChip(app.prefs.uiScale == sc, { app.prefs.uiScale(sc) }, { Text("${(sc * 100).toInt()} %") }) }
                }
                HorizontalDivider(color = hooked.line)
                Text("SERVER", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = hooked.muted, letterSpacing = 0.6.sp)
                ServerForm(app) { app.message = "Connected to ${app.config?.base}" }
                HorizontalDivider(color = hooked.line)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Background notifications", style = MaterialTheme.typography.titleSmall, color = hooked.ink)
                        Text(
                            "Counts the sessions waiting on you, and notifies when one starts waiting while the app is closed.",
                            fontSize = 12.sp, color = hooked.muted,
                        )
                    }
                    Switch(app.notify, {
                        app.changeNotify(it)
                        if (it) requestNotifications()
                    })
                }
            }
        },
        confirmButton = { TextButton({ app.showSettings = false }) { Text("Done") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun NewSessionDialog(app: AppModel) {
    val scope = rememberCoroutineScope()
    var cwd by rememberSaveable { mutableStateOf(app.newSessionProject ?: app.projects.firstOrNull().orEmpty()) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var model by rememberSaveable { mutableStateOf("") }
    var effort by rememberSaveable { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf("default") }
    var launching by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var allProjects by remember { mutableStateOf(false) }
    val caps = app.capabilities
    LaunchedEffect(Unit) {
        val d = runCatching { app.client?.defaults() }.getOrNull() ?: return@LaunchedEffect
        if (model.isEmpty()) model = d.model.orEmpty()
        if (effort.isEmpty()) effort = d.effort.orEmpty()
        d.mode?.takeIf { it in PermissionMode.launch }?.let { mode = it }
    }
    Dialog({ if (!launching) app.showNew = false }, DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.widthIn(max = 680.dp).fillMaxWidth(0.9f), shape = MaterialTheme.shapes.large, color = hooked.card) {
            Column(Modifier.padding(28.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("New session", style = MaterialTheme.typography.headlineSmall, color = hooked.ink)
                OutlinedTextField(
                    cwd, { cwd = it }, label = { Text("Project") }, singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = Mono), modifier = Modifier.fillMaxWidth(),
                )
                val projects = app.projects
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    (if (allProjects) projects else projects.take(8)).forEach { p ->
                        FilterChip(cwd == p, { cwd = p }, { Text(p.substringAfterLast('/')) })
                    }
                    if (projects.size > 8 && !allProjects) TextButton({ allProjects = true }) { Text("All ${projects.size} projects") }
                }
                OutlinedTextField(
                    prompt, { prompt = it }, label = { Text("What should Claude do?") }, minLines = 4, maxLines = 12,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Picker("Model", model.ifEmpty { "Default" }.let { if (it == "Default") it else caps.modelLabel(it) }, Modifier.weight(1.4f),
                        listOf("" to "Default") + caps.models.flatMap { g -> g.options.map { it.id to caps.modelLabel(it.id) } }) { model = it }
                    Picker("Effort", effort.ifEmpty { "Default" }, Modifier.weight(1f), listOf("" to "Default") + caps.efforts.map { it to it }) { effort = it }
                    Picker("Mode", PermissionMode.label(mode), Modifier.weight(1f), PermissionMode.launch.map { it to PermissionMode.label(it) }) { mode = it }
                }
                error?.let { Text(it, color = decisionStyle().ink) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                    if (launching) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    TextButton({ app.showNew = false }, enabled = !launching) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        {
                            launching = true
                            error = null
                            scope.launch {
                                try {
                                    val id = app.launch(cwd.trim(), prompt.trim(), model.ifEmpty { null }, effort.ifEmpty { null }, mode)
                                    app.showNew = false
                                    app.open(id)
                                } catch (e: Exception) {
                                    error = e.message
                                } finally {
                                    launching = false
                                }
                            }
                        },
                        enabled = cwd.isNotBlank() && prompt.isNotBlank() && !launching,
                    ) { Text("Launch") }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Picker(label: String, value: String, modifier: Modifier, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(open, { open = it }, modifier) {
        OutlinedTextField(
            value, {}, readOnly = true, label = { Text(label) }, singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
            modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(open, { open = false }) {
            options.forEach { (id, text) ->
                DropdownMenuItem({ Text(text) }, {
                    open = false
                    onPick(id)
                })
            }
        }
    }
}
