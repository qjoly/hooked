package dev.qjoly.hooked.ui.lens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.body
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.lens.McpLogin
import dev.qjoly.hooked.data.lens.McpServer
import dev.qjoly.hooked.data.lens.mcpAction
import dev.qjoly.hooked.data.lens.mcpList
import dev.qjoly.hooked.data.lens.mcpLogin
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Spinner
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.panel
import dev.qjoly.hooked.ui.pages.Centered
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The MCP lens of one session (lenses.rs `mcp_*`): its project's servers, health, details and OAuth login. */
class McpModel : ViewModel() {
    private var app: AppModel? = null
    private val client: HookedClient? get() = app?.client

    fun bind(app: AppModel) {
        this.app = app
    }

    var cwd by mutableStateOf<String?>(null)
        private set
    var servers by mutableStateOf<List<McpServer>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var open by mutableStateOf<String?>(null)
        private set
    var detail by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var login by mutableStateOf<McpLogin?>(null)
        private set
    var redirect by mutableStateOf("")
    var notice by mutableStateOf<String?>(null)
        private set

    fun ensure(project: String?) {
        val dir = project ?: return
        if (cwd == dir || loading) return
        cwd = dir
        servers = emptyList()
        detail = emptyMap()
        load(true)
    }

    /** The cached list answers at once; the live one health-checks every server, which takes seconds. */
    fun load(cachedFirst: Boolean) {
        val dir = cwd ?: return
        val c = client ?: return
        loading = true
        viewModelScope.launch {
            if (cachedFirst) runCatching { c.mcpList(dir, true) }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { servers = it }
            try {
                servers = c.mcpList(dir, false)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = "Could not list MCP servers: ${e.message}"
            } finally {
                loading = false
            }
        }
    }

    fun toggleDetail(name: String) {
        if (open == name) {
            open = null
            return
        }
        open = name
        if (detail.containsKey(name)) return
        val c = client ?: return
        val dir = cwd.orEmpty()
        viewModelScope.launch {
            val raw = try {
                c.mcpAction(body("action" to "get", "cwd" to dir, "name" to name))["raw"].str.orEmpty()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                "✗ ${e.message}"
            }
            detail = detail + (name to raw)
        }
    }

    fun logout(name: String) {
        val c = client ?: return
        val dir = cwd.orEmpty()
        viewModelScope.launch {
            notice = try {
                c.mcpAction(body("action" to "logout", "cwd" to dir, "name" to name))
                "Cleared credentials for $name."
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                "Logout failed for $name: ${e.message}"
            }
            load(false)
        }
    }

    fun reauth(name: String) {
        val c = client ?: return
        val dir = cwd.orEmpty()
        notice = null
        redirect = ""
        login = McpLogin(name = name)
        viewModelScope.launch {
            try {
                login = c.mcpLogin(body("action" to "login", "cwd" to dir, "name" to name))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                login = null
                notice = "Could not start the login: ${e.message}"
            }
        }
    }

    /** One poll of the login in flight; a finished login refreshes the list. */
    suspend fun poll() {
        val c = client ?: return
        val lid = login?.id ?: return
        val l = runCatching { c.mcpLogin(body("action" to "login-status", "id" to lid)) }.getOrNull() ?: return
        if (login?.id != lid) return
        login = l
        if (l.done) load(false)
    }

    fun sendRedirect() {
        val text = redirect.trim()
        val lid = login?.id ?: return
        if (text.isEmpty()) return
        redirect = ""
        val c = client ?: return
        viewModelScope.launch {
            runCatching { c.mcpLogin(body("action" to "login-input", "id" to lid, "text" to text)) }.getOrNull()?.let { login = it }
        }
    }

    fun cancelLogin() {
        val lid = login?.id
        login = null
        val c = client ?: return
        if (lid != null) viewModelScope.launch {
            runCatching { c.mcpAction(body("action" to "login-cancel", "id" to lid)) }
            load(false)
        }
    }
}

@Composable
private fun mcpDot(state: String): Color = when (state) {
    "connected" -> k.c.success.icon
    "needs-auth", "needs_auth", "auth" -> k.c.warning.icon
    "failed", "error" -> k.c.danger.icon
    else -> k.c.faint
}

/** rune's MCP lens. */
@Composable
fun McpLens(app: AppModel, model: SessionModel, modifier: Modifier = Modifier) {
    val m: McpModel = viewModel(key = "mcp:${model.id}") { McpModel() }
    m.bind(app)
    val project = model.detail?.session?.project
    LaunchedEffect(project, app.client, m.loading) { m.ensure(project) }
    val login = m.login
    LaunchedEffect(login?.id, login?.done) {
        val lid = login?.id ?: return@LaunchedEffect
        if (login.done) return@LaunchedEffect
        while (true) {
            delay(1500)
            m.poll()
            val now = m.login
            if (now == null || now.done || now.id != lid) break
        }
    }
    Column(modifier.fillMaxSize()) {
        LensBar {
            KIcon(Lucide.Plug, k.c.muted, 14.dp)
            Text("MCP servers · ${project.orEmpty()}", style = k.ty.uiMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.weight(1f))
            if (m.loading) {
                Text("health-checking…", style = k.ty.textXsmall, color = k.c.faint)
                Spinner()
            }
            KButton("Refresh", { m.load(false) }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Restart, enabled = !m.loading)
        }
        Box(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())) {
            Centered(1000.dp) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    m.notice?.let { Text(it, style = k.ty.ui, color = k.c.muted) }
                    LoginCard(m)
                    var scope: String? = null
                    var first = true
                    for (x in m.servers) {
                        if (first || scope != x.scopeLabel) {
                            first = false
                            scope = x.scopeLabel
                            SectionTitle((x.scopeLabel ?: "Other").uppercase(), Modifier.padding(top = 8.dp))
                        }
                        ServerRow(m, x)
                    }
                    if (m.servers.isEmpty() && !m.loading) Text("No MCP servers for this project.", style = k.ty.body, color = k.c.faint)
                }
            }
        }
    }
}

@Composable
private fun ServerRow(m: McpModel, x: McpServer) {
    val open = m.open == x.name
    Column(Modifier.fillMaxWidth().panel(k.c.surface, k.c.border, k.r.md).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Dot(mcpDot(x.state), 8.dp)
            Text(x.name, style = k.ty.uiMedium, color = k.c.fg, maxLines = 1)
            Text("${x.transport.orEmpty()} · ${x.target.orEmpty()}", style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(x.status ?: x.state, style = k.ty.textSmall, color = k.c.muted, maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                KButton(if (open) "Hide" else "Details", { m.toggleDetail(x.name) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
                if (x.authable) {
                    KButton("Re-authenticate", { m.reauth(x.name) }, variant = if (x.state == "connected") Variant.GHOST_MUTED else Variant.CONTRAST, size = Size.SMALL)
                    KButton("Log out", { m.logout(x.name) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
                }
            }
        }
        if (open) SelectionContainer { Text(m.detail[x.name] ?: "Loading…", style = k.ty.mono, color = k.c.muted) }
    }
}

@Composable
private fun LoginCard(m: McpModel) {
    val l = m.login ?: return
    val uri = LocalUriHandler.current
    Column(Modifier.fillMaxWidth().panel(k.c.surface, k.c.info.border, k.r.lg).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Signing in to ${l.name}", style = k.ty.uiMedium, color = k.c.fg)
            Spacer(Modifier.weight(1f))
            if (!l.done) Spinner()
        }
        l.url?.let { url ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                KButton("Open the sign-in page", { runCatching { uri.openUri(url) } }, variant = Variant.CONTRAST, size = Size.REGULAR, icon = Lucide.Link)
                Text(url, style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        when {
            l.done -> Text(
                when {
                    l.outOfBand -> "Finish the approval on claude.ai; the connector picks it up next time Claude Code starts."
                    l.exitCode == 0 -> "Signed in."
                    else -> "The login ended without success; see the output below."
                },
                style = k.ty.ui, color = k.c.muted,
            )
            l.needsPaste -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                KTextInput(m.redirect, { m.redirect = it }, "Paste the redirect URL from the browser…", Modifier.weight(1f), onSubmit = m::sendRedirect)
                KButton("Send", m::sendRedirect, variant = Variant.OUTLINE, size = Size.REGULAR, enabled = m.redirect.isNotBlank())
            }
        }
        val out = l.output.trim()
        if (out.isNotEmpty()) {
            val scroll = rememberScrollState()
            LaunchedEffect(out) { scroll.scrollTo(scroll.maxValue) }
            Box(Modifier.fillMaxWidth().heightIn(max = 160.dp).verticalScroll(scroll)) {
                SelectionContainer { Text(out, style = k.ty.mono, color = k.c.faint) }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            KButton(if (l.done) "Close" else "Cancel", m::cancelLogin, variant = Variant.OUTLINE, size = Size.REGULAR)
        }
    }
}
