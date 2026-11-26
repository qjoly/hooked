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
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
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
import dev.qjoly.hooked.ui.pages.CronPage
import dev.qjoly.hooked.ui.pages.DigestPage
import dev.qjoly.hooked.ui.pages.GithubPage
import dev.qjoly.hooked.ui.pages.MemoryPage
import dev.qjoly.hooked.ui.pages.ModuleOff
import dev.qjoly.hooked.ui.pages.PromptsPage
import dev.qjoly.hooked.ui.pages.SkillsPage
import dev.qjoly.hooked.ui.pages.StatsPage
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
    BackHandler(app.page != Page.Deck) { app.openDeck() }
    BoxWithConstraints(
        Modifier.fillMaxSize().safeDrawingPadding().onPreviewKeyEvent { e ->
            // ⌘K / Ctrl+K opens the palette from anywhere, as in rune.
            val hit = e.key == Key.K && (e.isMetaPressed || e.isCtrlPressed)
            if (hit && e.type == KeyEventType.KeyDown) palette = !palette
            hit || organizeShortcut(app, e)
        },
    ) {
        val wide = maxWidth >= 1150.dp
        Column(Modifier.fillMaxSize()) {
            TopBar(app, wide, { palette = true }, { account = true }, { trash = true })
            Row(Modifier.weight(1f).fillMaxWidth()) {
                if (app.prefs.sidebarOpen) Sidebar(app) else Rail(app)
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    when (val p = app.page) {
                        Page.Deck -> DeckScreen(app)
                        is Page.Session -> SessionPane(app, p.id, onBack = null)
                        Page.New -> NewSessionPage(app)
                        Page.Stats -> StatsPage(app)
                        Page.Digest -> DigestPage(app)
                        Page.Memory -> MemoryPage(app)
                        Page.Cron -> if (app.moduleOn("cron")) CronPage(app) else ModuleOff("Cron")
                        Page.Github -> if (app.moduleOn("github")) GithubPage(app) else ModuleOff("GitHub")
                        Page.Skills -> SkillsPage(app)
                        Page.Prompts -> PromptsPage(app)
                        Page.Settings -> SettingsPage(app, requestNotifications)
                    }
                }
            }
        }
        QueryWindow(app)
        DragGhost(app)
    }
    if (app.quickOpen) QuickReply(app)
    if (palette) Palette(app, { trash = true }, requestNotifications) { palette = false }
    if (account) AccountModal(app) { account = false }
    if (trash) TrashModal(app) { trash = false }
}
