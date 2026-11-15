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
internal fun AccountModal(app: AppModel, close: () -> Unit) {
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
internal fun TrashModal(app: AppModel, close: () -> Unit) {
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
