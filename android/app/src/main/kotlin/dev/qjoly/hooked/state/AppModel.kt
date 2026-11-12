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
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.sseFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.launch

enum class Destination { DECK, SESSIONS }

/** App-wide state: the server, the session list and where the user is. */
class AppModel(app: Application) : AndroidViewModel(app) {
    var config by mutableStateOf(ServerConfig.load(app))
        private set
    var client by mutableStateOf(config?.let(::HookedClient))
        private set

    var sessions by mutableStateOf<List<Session>>(emptyList())
        private set
    var archived by mutableStateOf<Set<String>>(emptySet())
        private set
    var snoozed by mutableStateOf<Map<String, Long>>(emptyMap())
        private set
    var loaded by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var capabilities by mutableStateOf(Capabilities())
        private set
    var gauges by mutableStateOf<List<Gauge>>(emptyList())
        private set

    var destination by mutableStateOf(Destination.DECK)
    var selected by mutableStateOf<String?>(null)
    var showNew by mutableStateOf(false)
    var showSettings by mutableStateOf(false)
    var notify by mutableStateOf(AppPrefs.notify(app))
        private set

    /** One-off message for the snackbar. */
    var message by mutableStateOf<String?>(null)

    private var streamJob: Job? = null
    private var lastUsage = 0L
    private val ticks = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    fun session(id: String?) = sessions.firstOrNull { it.id == id }

    /** Distinct project paths, most recently active first. */
    val projects: List<String> get() = sessions.mapNotNull { it.project }.distinct()

    /** Sessions shown in the lists: archived ones are left to the web dashboard. */
    val visible: List<Session> get() = sessions.filter { it.id !in archived }

    fun isSnoozed(id: String, now: Long = System.currentTimeMillis()) = (snoozed[id] ?: 0L) > now

    fun start() {
        val c = client ?: return
        if (streamJob != null) return
        streamJob = viewModelScope.launch {
            launch { runCatching { capabilities = c.capabilities() } }
            // Ticks come on every hook event and every 4 s: 250 ms debounce, one fetch per second at most.
            launch {
                ticks.conflate().collect {
                    delay(250)
                    refresh()
                    delay(750)
                }
            }
            refresh()
            sseFlow(c.url("api/stream")).collect { ticks.tryEmit(Unit) }
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
            runCatching { c.sessionMeta() }.getOrNull()?.let { meta ->
                archived = meta.filterValues { it["archived"].bool }.keys
                snoozed = meta.mapNotNull { (k, v) -> v["snoozeUntil"].dbl?.let { k to it.toLong() } }.toMap()
            }
            loaded = true
            error = null
            val now = System.currentTimeMillis()
            if (now - lastUsage > 60_000) {
                lastUsage = now
                runCatching { gauges = c.usage() }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        }
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
            loaded = false
            selected = null
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
        selected = id
        destination = Destination.SESSIONS
    }

    /** Runs a server call, reports a failure in the snackbar, refreshes on success. */
    fun act(block: suspend (HookedClient) -> Unit) {
        val c = client ?: return
        viewModelScope.launch {
            try {
                block(c)
                refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                message = e.message
            }
        }
    }

    fun snooze(id: String, hours: Int) = act { it.snooze(id, System.currentTimeMillis() + hours * 3_600_000L) }

    fun archive(id: String) = act {
        it.archive(id)
        if (selected == id) selected = null
    }

    suspend fun launch(cwd: String, prompt: String, model: String?, effort: String?, mode: String?): String {
        val c = client ?: throw IllegalStateException("Not connected")
        val id = c.launch(cwd, prompt, model, effort, mode)
        refresh()
        return id
    }
}
