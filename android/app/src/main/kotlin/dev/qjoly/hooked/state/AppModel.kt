package dev.qjoly.hooked.state

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.qjoly.hooked.AppPrefs
import dev.qjoly.hooked.ServerConfig
import dev.qjoly.hooked.WatchService
import dev.qjoly.hooked.data.Capabilities
import dev.qjoly.hooked.data.Gauge
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.Meta
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.sseFlow
import dev.qjoly.hooked.data.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** Where the main area is, as rune's top-level pages. */
sealed interface Page {
    data object Deck : Page
    data class Session(val id: String) : Page
    data object New : Page
    data object Stats : Page
    data object Digest : Page
    data object Memory : Page
    data object Cron : Page
    data object Github : Page
    data object Skills : Page
    data object Prompts : Page
    data object Settings : Page
}

/** App-wide state, as desktop-rune's `Hooked` holds it: the server, the lists, the prefs and the page. */
class AppModel(app: Application) : AndroidViewModel(app) {
    val prefs = UiPrefs(app)

    var config by mutableStateOf(ServerConfig.load(app))
        private set
    var client by mutableStateOf(config?.let(::HookedClient))
        private set

    var sessions by mutableStateOf<List<Session>>(emptyList())
        private set
    var meta by mutableStateOf<Map<String, Meta>>(emptyMap())
        private set
    var tags by mutableStateOf<Map<String, List<String>>>(emptyMap())
        private set
    var settings by mutableStateOf(JsonObject(emptyMap()))
        private set
    var loaded by mutableStateOf(false)
        private set
    var connected by mutableStateOf(false)
        private set
    var capabilities by mutableStateOf(Capabilities())
        private set
    var gauges by mutableStateOf<List<Gauge>>(emptyList())
        private set

    var page by mutableStateOf<Page>(Page.Deck)

    /** The last open session, so the Sessions tab comes back to it. */
    var lastSession by mutableStateOf<String?>(null)
        private set

    var showNew by mutableStateOf(false)
    var newSessionProject by mutableStateOf<String?>(null)
    var showSettings by mutableStateOf(false)
    var notify by mutableStateOf(AppPrefs.notify(app))
        private set

    /** Transient sidebar filters, cleared when incognito mode flips. */
    var repoFilter by mutableStateOf<Set<String>>(emptySet())
    var tagFilter by mutableStateOf<Set<String>>(emptySet())

    /** The top bar's "✓ …" / "✗ …" line, gone after 4 s. */
    var flash by mutableStateOf<String?>(null)
        private set
    private var flashJob: Job? = null

    /** The clock ages and countdowns read; it ticks every 30 s. */
    var now by mutableStateOf(System.currentTimeMillis())
        private set

    private var streamJob: Job? = null
    private var lastUsage = 0L
    private val ticks = MutableSharedFlow<kotlin.Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    val selected: String? get() = (page as? Page.Session)?.id

    fun session(id: String?) = sessions.firstOrNull { it.id == id }

    fun title(s: Session) = titleOf(s, prefs.names)

    fun tagsOf(id: String) = tags[id].orEmpty()

    /** Visible in the current incognito mode. */
    val visible: List<Session> get() = sessions.filter { isVisible(it, meta, prefs.incognito) }

    val active: List<Session> get() = visible.filter { !isArchived(it, meta, now) }

    /** Distinct project paths, most recently active first. */
    val projects: List<String> get() = sessions.mapNotNull { it.worktreeOf ?: it.project }.distinct()

    // Kept for the screens that still speak the first port's vocabulary.
    var message: String?
        get() = flash
        set(v) { v?.let { say(if (it.startsWith("✓") || it.startsWith("✗")) it else "✗ $it") } }

    fun say(text: String) {
        flash = text
        flashJob?.cancel()
        flashJob = viewModelScope.launch {
            delay(4_000)
            flash = null
        }
    }

    init {
        viewModelScope.launch {
            while (isActive) {
                delay(30_000)
                now = System.currentTimeMillis()
            }
        }
    }

    fun start() {
        val c = client ?: return
        if (streamJob != null) return
        streamJob = viewModelScope.launch {
            launch { runCatching { capabilities = c.capabilities() } }
            launch { runCatching { settings = c.settings() } }
            // Ticks come on every hook event and every 4 s: 250 ms debounce, one fetch per second at most.
            launch {
                ticks.conflate().collect {
                    delay(250)
                    refresh()
                    delay(750)
                }
            }
            refresh()
            while (isActive) {
                try {
                    sseFlow(c.url("api/stream")).collect {
                        connected = true
                        if (!onStreamEvent(it)) ticks.tryEmit(kotlin.Unit)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
                connected = false
                delay(3_000)
            }
        }
    }

    fun stop() {
        streamJob?.cancel()
        streamJob = null
    }

    suspend fun refresh() {
        val c = client ?: return
        try {
            val list = c.sessions()
            if (list != sessions) sessions = list
            runCatching { c.sessionMeta() }.getOrNull()?.let { if (it != meta) meta = it }
            runCatching { c.tags() }.getOrNull()?.let { if (it != tags) tags = it }
            loaded = true
            connected = true
            now = System.currentTimeMillis()
            if (now - lastUsage > 60_000) {
                lastUsage = now
                runCatching { gauges = c.usage() }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            connected = false
        }
    }

    /** Rereads the server settings after a page wrote one (the prompt library, say). */
    fun reloadSettings() {
        val c = client ?: return
        viewModelScope.launch { runCatching { settings = c.settings() } }
    }

    fun refreshSoon() {
        viewModelScope.launch { refresh() }
    }

    /** Tests the server, then switches to it. Returns the error, if any. */
    suspend fun pair(cfg: ServerConfig): String? {
        val c = HookedClient(cfg)
        return try {
            c.ping()
            cfg.save(getApplication())
            stop()
            config = cfg
            client = c
            sessions = emptyList()
            meta = emptyMap()
            loaded = false
            page = Page.Deck
            WatchService.restart(getApplication())
            start()
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            e.message ?: "Connection failed"
        }
    }

    fun changeNotify(on: Boolean) {
        AppPrefs.setNotify(getApplication(), on)
        notify = on
        WatchService.sync(getApplication())
    }

    fun open(id: String) {
        page = Page.Session(id)
        lastSession = id
    }

    fun openDeck() {
        page = Page.Deck
    }

    /** New session, optionally in a project (the sidebar's and the fleet's "+"). */
    fun openNew(project: String? = null) {
        newSessionProject = project
        page = Page.New
    }

    fun openSettings() {
        page = Page.Settings
    }

    /** The Sessions tab: the last open session, else the first one listed. */
    fun openSessions() {
        val id = lastSession?.takeIf { session(it) != null } ?: active.firstOrNull()?.id ?: return
        open(id)
    }

    /** Runs a server call; a failure lands in the flash, success refreshes. */
    fun act(failure: String = "Action", success: String? = null, block: suspend (HookedClient) -> kotlin.Unit) {
        val c = client ?: return
        viewModelScope.launch {
            try {
                block(c)
                success?.let(::say)
                refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say("✗ $failure: ${e.message}")
            }
        }
    }

    private fun patchLocal(id: String, f: (Meta) -> Meta) {
        meta = meta + (id to f(meta.of(id)))
    }

    fun snooze(id: String, until: Long?) {
        patchLocal(id) { it.copy(snoozeUntil = until) }
        act("Snooze", until?.let { "✓ Snoozed until ${wakeLabel(it, System.currentTimeMillis())}" }) { it.patchMeta(id, "snoozeUntil", until) }
    }

    fun snoozeAll(ids: List<String>, hours: Int) {
        val until = System.currentTimeMillis() + hours * 3_600_000L
        ids.forEach { id -> patchLocal(id) { it.copy(snoozeUntil = until) } }
        act("Snooze", "✓ Snoozed until ${wakeLabel(until, System.currentTimeMillis())}") { c -> ids.forEach { c.patchMeta(it, "snoozeUntil", until) } }
    }

    /** A lead with others flips the members that matched its own flag; live sessions are stopped before archiving. */
    fun toggleArchive(id: String) {
        val lead = session(id) ?: return
        val wasArchived = meta.of(id).archived
        val members = sessions.filter { meta.of(it.id).groupOf == id && it.id != id }
        val targets = members.filter { meta.of(it.id).archived == wasArchived } + lead
        targets.forEach { s -> patchLocal(s.id) { it.copy(archived = !wasArchived) } }
        if (!wasArchived && selected == id) page = Page.Deck
        act("Archive") { c ->
            for (s in targets) {
                if (!wasArchived && s.live) runCatching { c.kill(s.id) }
                c.patchMeta(s.id, "archived", !wasArchived)
            }
        }
    }

    fun archive(id: String) = toggleArchive(id)

    /** A lead flags its whole group; a child only itself. */
    fun toggleIncognito(id: String) {
        val on = !meta.of(id).incognito
        val isChild = meta.of(id).groupOf.let { it != null && it != id }
        val targets = if (isChild) listOf(id) else listOf(id) + sessions.filter { meta.of(it.id).groupOf == id }.map { it.id }
        targets.forEach { t -> patchLocal(t) { it.copy(incognito = on) } }
        act("Incognito") { c -> targets.forEach { c.patchMeta(it, "incognito", on) } }
    }

    fun toggleIncognitoMode() {
        prefs.incognito(!prefs.incognito)
        repoFilter = emptySet()
        tagFilter = emptySet()
    }

    fun groupOp(op: String, id: String, target: String? = null, name: String? = null) {
        val done = when (op) {
            "join" -> "✓ Moved to the group"
            "leave" -> "✓ Left the group"
            "rename" -> "✓ Group renamed"
            else -> "✓ New lead session"
        }
        act("Group", done) { it.groupOp(op, id, target, name) }
    }

    fun setTags(id: String, list: List<String>) {
        tags = tags + (id to list)
        act("Tags", "✓ Tags saved") { it.setTags(id, list) }
    }

    /** rune's quick reply window (⌘⇧H). */
    var quickOpen by mutableStateOf(false)

    /** The floating Grafana query window, open while non-null. */
    var queryRequest by mutableStateOf<QueryRequest?>(null)

    fun openQuerySpec(spec: JsonObject) {
        queryRequest = QueryRequest.Spec(spec)
    }

    fun openQueryResult(session: String, toolId: String) {
        queryRequest = QueryRequest.Result(session, toolId)
    }

    /** A `showQuery` event (the MCP `show_query` tool) opens the query window; true when the payload was one. */
    private fun onStreamEvent(payload: String): Boolean {
        if (!payload.contains("\"spec\"")) return false
        val spec = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(payload)["spec"] as? JsonObject }.getOrNull() ?: return false
        if (spec["query"].str == null) return false
        openQuerySpec(spec)
        return true
    }

    suspend fun launch(cwd: String, prompt: String, model: String?, effort: String?, mode: String?): String {
        val c = client ?: throw IllegalStateException("Not connected")
        val id = c.launch(cwd, prompt, model, effort, mode)
        refresh()
        return id
    }

    /** `sidebarCache` from the server settings: badge or replace, and the window in minutes. */
    val cacheDisplay: String get() = settings["sidebarCache"]["display"].str ?: "badge"
    val cacheWindowMin: Int get() = settings["sidebarCache"]["windowMin"].int ?: 15

    /** `navTabs` from the server settings; missing means every tab. */
    val navTabs: Set<String>? get() = settings["navTabs"]?.arr?.mapNotNull { it.str }?.toSet()
}
