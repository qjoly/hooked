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

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SettingsDialog(app: AppModel, requestNotifications: () -> Unit) {
    AlertDialog(
        onDismissRequest = { app.openDeck() },
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
        confirmButton = { TextButton({ app.openDeck() }) { Text("Done") } },
    )
}

/** rune's Settings page (`view/settings.rs`). For now the first port's dialog. */
@Composable
fun SettingsPage(app: AppModel, requestNotifications: () -> Unit) = SettingsDialog(app, requestNotifications)
