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
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import dev.qjoly.hooked.data.account
import dev.qjoly.hooked.data.accountAction
import dev.qjoly.hooked.data.int

/** rune's account modal (account.rs): who is signed in, switching account through `claude auth login`, signing out. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AccountModal(app: AppModel, close: () -> Unit) {
    val c = k.c
    val client = app.client ?: return
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var info by remember { mutableStateOf<JsonElement?>(null) }
    var login by remember { mutableStateOf<JsonElement?>(null) }
    var starting by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var redirect by remember { mutableStateOf("") }
    var confirmLogout by remember { mutableStateOf(false) }
    suspend fun refresh() { info = runCatching { client.account() }.getOrNull() }
    suspend fun action(name: String, vararg extra: Pair<String, Any?>) {
        try {
            val l = client.accountAction(name, *extra)["login"] ?: return
            if (l is kotlinx.serialization.json.JsonNull) return
            login = l
            if (l["done"].bool) {
                val ok = l["exitCode"].int == 0
                notice = if (ok) "Signed in." else "The login flow ended before completing."
                if (ok) refresh()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            notice = e.message
        } finally {
            starting = false
        }
    }
    LaunchedEffect(Unit) { refresh() }
    // Follows a login flow until the CLI exits, every 1.5 s.
    val loginId = login?.get("id").str?.takeIf { !login?.get("done").bool }
    LaunchedEffect(loginId) {
        val id = loginId ?: return@LaunchedEffect
        while (true) {
            delay(1_500)
            action("login-status", "id" to id)
            if (login?.get("done").bool || login?.get("id").str != id) break
        }
    }
    fun startLogin(mode: String) {
        starting = true
        login = null
        notice = null
        scope.launch { action("login", "mode" to mode) }
    }
    fun cancelLogin() {
        val id = login?.get("id").str
        login = null
        starting = false
        if (id != null) scope.launch { runCatching { client.accountAction("login-cancel", "id" to id) } }
    }
    fun sendRedirect() {
        val id = login?.get("id").str ?: return
        val text = redirect.trim()
        if (text.isEmpty()) return
        redirect = ""
        scope.launch { action("login-input", "id" to id, "text" to text) }
    }
    KModal(close, "Claude account") {
        val i = info
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(i?.get("displayName").text ?: i?.get("email").text ?: "Loading…", style = k.ty.uiMedium, color = c.fg)
            listOfNotNull(i?.get("email").text, i?.get("organizationName").text, i?.get("subscriptionType").text).forEach {
                Text(it, style = k.ty.textSmall, color = c.muted)
            }
            if (i?.get("loggedIn") is kotlinx.serialization.json.JsonPrimitive && !i["loggedIn"].bool) Text("Not signed in", style = k.ty.textSmall, color = c.warning.fg)
        }
        notice?.let { Text(it, style = k.ty.textSmall, color = c.muted) }
        val l = login
        if (l != null || starting) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val url = l?.get("url").text
                when {
                    starting -> Text("Starting the login flow…", style = k.ty.textSmall, color = c.faint)
                    l != null && l["done"].bool -> Text(
                        if (l["exitCode"].int == 0) "Signed in." else "The login flow ended before completing.",
                        style = k.ty.textSmall, color = c.muted,
                    )
                    url != null -> {
                        Text("Open this page to approve the sign-in:", style = k.ty.textSmall, color = c.muted)
                        androidx.compose.foundation.text.selection.SelectionContainer { Text(url, style = k.ty.textXsmall, color = c.accent) }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            KButton("Open", { dev.qjoly.hooked.ui.session.openUrl(ctx, url) }, variant = Variant.OUTLINE)
                            KButton("Copy", { dev.qjoly.hooked.ui.session.copyText(ctx, url); app.say("✓ Copied") }, variant = Variant.GHOST_MUTED)
                        }
                        if (l["needsPaste"].bool) {
                            KTextInput(redirect, { redirect = it }, "Paste the code or redirect URL…", Modifier.fillMaxWidth(), onSubmit = ::sendRedirect)
                        } else {
                            Text("Waiting for authorization…", style = k.ty.textSmall, color = c.faint)
                        }
                    }
                    else -> Text("Starting…", style = k.ty.textSmall, color = c.faint)
                }
                if (l == null || !l["done"].bool) Row { KButton("Cancel", ::cancelLogin, variant = Variant.GHOST_MUTED) }
            }
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                KButton("Switch account (Claude subscription)", { startLogin("claudeai") }, variant = Variant.CONTRAST)
                KButton("Switch to Console / API billing", { startLogin("console") }, variant = Variant.OUTLINE)
            }
            Text(
                "Runs the same sign-in flow as claude auth login. It replaces the credentials the CLI keeps on this machine: every session, not just hooked's, uses the new account afterwards.",
                style = k.ty.textXsmall, color = c.faint,
            )
            if (confirmLogout) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Sign out of Claude on this machine?", style = k.ty.textSmall, color = c.fg)
                    KButton("Sign out", {
                        scope.launch {
                            try {
                                client.accountAction("logout")
                                app.say("✓ Signed out")
                                confirmLogout = false
                                refresh()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                app.say("✗ Sign out: ${e.message}")
                            }
                        }
                    }, variant = Variant.DANGER)
                    KButton("Cancel", { confirmLogout = false }, variant = Variant.GHOST_MUTED)
                }
            } else {
                Row { KButton("Sign out…", { confirmLogout = true }, variant = Variant.GHOST_MUTED) }
            }
        }
    }
}

/** Deleted sessions: the transcript stays in bin/ and comes back on Restore. */
@Composable
internal fun TrashModal(app: AppModel, close: () -> Unit) {
    val c = k.c
    var items by remember { mutableStateOf<List<JsonElement>?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val client = app.client ?: return
    suspend fun load() { items = runCatching { client.get("api/trash")["trashed"].arr.distinctBy { it["id"].str } }.getOrNull() ?: emptyList() }
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
        val line = c.border
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (t in list.orEmpty()) {
                val id = t["id"].str ?: continue
                Row(
                    Modifier.fillMaxWidth().drawBehind { drawLine(line, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        val title = listOf("title", "firstPrompt").mapNotNull { t[it].text }.firstOrNull { it != "(sans titre)" } ?: "(untitled)"
                        Text(title, style = k.ty.ui, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val ago = t["trashedAt"].millis?.let { agoShort(it, app.now) } ?: "—"
                        val cost = t["cost"].dbl?.takeIf { it > 0 }?.let { " · ${costLabel(it)}" }.orEmpty()
                        Text("${t["projectName"].text ?: "?"} · deleted $ago ago$cost", style = k.ty.textXsmall, color = c.faint)
                    }
                    KButton(if (busy == id) "Restoring…" else "Restore", {
                        busy = id
                        scope.launch {
                            try {
                                client.post("api/restore", body("id" to id))
                                items = items?.filter { it["id"].str != id }
                                app.say("✓ Restored")
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                app.say("✗ Restore: ${e.message}")
                            }
                            busy = null
                            app.refresh()
                        }
                    }, variant = Variant.OUTLINE, enabled = busy == null)
                }
            }
        }
    }
}
