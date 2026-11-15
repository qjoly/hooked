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

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun NewSessionDialog(app: AppModel) {
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
    Dialog({ if (!launching) app.openDeck() }, DialogProperties(usePlatformDefaultWidth = false)) {
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
                    TextButton({ app.openDeck() }, enabled = !launching) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        {
                            launching = true
                            error = null
                            scope.launch {
                                try {
                                    val id = app.launch(cwd.trim(), prompt.trim(), model.ifEmpty { null }, effort.ifEmpty { null }, mode)
                                    app.openDeck()
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
internal fun Picker(label: String, value: String, modifier: Modifier, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
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

/** rune's New session page (`view/new_session.rs`). For now the first port's form. */
@Composable
fun NewSessionPage(app: AppModel) = NewSessionDialog(app)
