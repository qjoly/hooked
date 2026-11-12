package dev.qjoly.hooked.ui

import androidx.activity.compose.BackHandler
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
import dev.qjoly.hooked.ServerConfig
import dev.qjoly.hooked.data.Gauge
import dev.qjoly.hooked.data.PermissionMode
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.Destination
import kotlinx.coroutines.launch

@Composable
fun HookedApp(app: AppModel, requestNotifications: () -> Unit) {
    HookedTheme {
        Surface(Modifier.fillMaxSize(), color = hooked.ground) {
            if (app.config == null) ConnectScreen(app) else Shell(app, requestNotifications)
        }
    }
}

@Composable
private fun Logo(size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size).clip(CircleShape).background(Color(0xFF1E1512)), contentAlignment = Alignment.Center) {
        Image(painterResource(R.drawable.ic_launcher_foreground), "hooked", Modifier.size(size * 1.5f))
    }
}

@Composable
private fun Shell(app: AppModel, requestNotifications: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(app.message) {
        app.message?.let {
            app.message = null
            snackbar.showSnackbar(it)
        }
    }
    Scaffold(snackbarHost = { SnackbarHost(snackbar) }, containerColor = hooked.ground, contentWindowInsets = WindowInsets.safeDrawing) { pad ->
        Row(Modifier.padding(pad).fillMaxSize()) {
            Rail(app)
            VerticalDivider(color = hooked.line)
            Box(Modifier.weight(1f).fillMaxHeight()) {
                when (app.destination) {
                    Destination.DECK -> DeckScreen(app)
                    Destination.SESSIONS -> SessionsScreen(app)
                }
            }
        }
    }
    if (app.showNew) NewSessionDialog(app)
    if (app.showSettings) SettingsDialog(app, requestNotifications)
}

@Composable
private fun Rail(app: AppModel) {
    val now = rememberNow()
    val waiting = app.visible.count { bucket(it, now) == 0 && !app.isSnoozed(it.id, now) }
    val colors = NavigationRailItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.secondaryContainer)
    NavigationRail(
        containerColor = hooked.panel,
        windowInsets = WindowInsets(0),
        header = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.padding(top = 12.dp)) {
                Logo(44.dp)
                FloatingActionButton({ app.showNew = true }, containerColor = MaterialTheme.colorScheme.primary) {
                    Icon(Icons.Rounded.Add, "New session")
                }
            }
        },
    ) {
        Spacer(Modifier.height(12.dp))
        NavigationRailItem(
            selected = app.destination == Destination.DECK,
            onClick = { app.destination = Destination.DECK },
            icon = {
                BadgedBox(badge = { if (waiting > 0) Badge(containerColor = decisionStyle().hue, contentColor = Color.White) { Text("$waiting") } }) {
                    Icon(Icons.Outlined.Dashboard, null)
                }
            },
            label = { Text("Deck") },
            colors = colors,
        )
        NavigationRailItem(
            selected = app.destination == Destination.SESSIONS,
            onClick = { app.destination = Destination.SESSIONS },
            icon = { Icon(Icons.Outlined.Forum, null) },
            label = { Text("Sessions") },
            colors = colors,
        )
        Spacer(Modifier.weight(1f))
        app.gauges.forEach { RailGauge(it) }
        Spacer(Modifier.height(8.dp))
        NavigationRailItem(
            selected = false,
            onClick = { app.showSettings = true },
            icon = { Icon(Icons.Outlined.Settings, null) },
            label = { Text("Settings") },
            colors = colors,
        )
        Spacer(Modifier.height(12.dp))
    }
}

/** The dashboard's 5H / 7D usage gauges, stacked in the rail. */
@Composable
private fun RailGauge(g: Gauge) {
    val hue = when {
        g.pct >= 90 -> decisionStyle().hue
        g.pct >= 70 -> stateStyle(SessionState.WAITING).hue
        else -> stateStyle(SessionState.WORKING).hue
    }
    Column(Modifier.width(64.dp).padding(vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(g.label, fontSize = 10.sp, fontWeight = FontWeight.Bold, color = hooked.muted, maxLines = 1, overflow = TextOverflow.Clip)
            Text("${g.pct}%", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = hooked.ink)
        }
        Spacer(Modifier.height(3.dp))
        LinearProgressIndicator({ g.pct / 100f }, Modifier.fillMaxWidth().height(4.dp), color = hue, trackColor = hooked.line, drawStopIndicator = {})
    }
}

@Composable
private fun SessionsScreen(app: AppModel) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val selected = app.selected
        if (maxWidth >= 840.dp) {
            Row(Modifier.fillMaxSize()) {
                SessionListPane(app, selected, onOpen = { app.selected = it }, modifier = Modifier.width(360.dp))
                VerticalDivider(color = hooked.line)
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    if (selected != null) SessionPane(app, selected, onBack = null) else EmptyDetail()
                }
            }
        } else if (selected != null) {
            BackHandler { app.selected = null }
            SessionPane(app, selected, onBack = { app.selected = null })
        } else {
            SessionListPane(app, null, onOpen = { app.selected = it })
        }
    }
}

@Composable
private fun EmptyDetail() {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Logo(72.dp)
        Spacer(Modifier.height(16.dp))
        Text("Pick a session", style = MaterialTheme.typography.titleLarge, color = hooked.ink)
        Text("Its conversation opens here.", color = hooked.muted)
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
                Logo(64.dp)
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

@Composable
private fun SettingsDialog(app: AppModel, requestNotifications: () -> Unit) {
    AlertDialog(
        onDismissRequest = { app.showSettings = false },
        title = { Text("Settings") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
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
    var cwd by rememberSaveable { mutableStateOf(app.projects.firstOrNull().orEmpty()) }
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
