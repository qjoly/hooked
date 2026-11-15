package dev.qjoly.hooked.ui.session

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.Message
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.dock.DockData
import dev.qjoly.hooked.data.dock.GhRun
import dev.qjoly.hooked.data.dock.agentTranscript
import dev.qjoly.hooked.data.dock.appendLog
import dev.qjoly.hooked.data.dock.bytes
import dev.qjoly.hooked.data.dock.dockData
import dev.qjoly.hooked.data.dock.fixPrompt
import dev.qjoly.hooked.data.dock.ghDetail
import dev.qjoly.hooked.data.dock.ghDiff
import dev.qjoly.hooked.data.dock.ghJobLog
import dev.qjoly.hooked.data.dock.ghRun
import dev.qjoly.hooked.data.dock.ghSummary
import dev.qjoly.hooked.data.dock.jobLog
import dev.qjoly.hooked.data.dock.parseRunUrl
import dev.qjoly.hooked.data.dock.stripAnsi
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.util.Base64

enum class Fix { SENDING, SENT, FAILED }

/** The widened dock showing one link in full (`ghdetail.rs::GhView`). */
data class GhView(
    val url: String,
    val session: String?,
    val tab: Int = 0,
    val files: Set<String> = emptySet(),
    val comments: Set<String> = emptySet(),
    val bots: Boolean = false,
    val fixed: Map<String, Fix> = emptyMap(),
)

/** The GitHub Actions run window (`ghrun.rs::RunWin`); `log` is the job id and its log, null while it runs. */
data class RunWin(
    val owner: String,
    val url: String,
    val run: GhRun? = null,
    val err: String? = null,
    val job: String? = null,
    val log: Pair<String, Result<String?>>? = null,
    val loading: Boolean = false,
    val polled: Long = 0,
)

data class ImageViewer(val session: String, val paths: List<String>, val index: Int)

data class AgentViewer(val session: String, val title: String, val messages: List<Message>?)

/** The dock's state, app-wide like rune's: open cards and GitHub caches survive a session switch. */
class DockModel : ViewModel() {
    private var client: HookedClient? = null

    /** The dock fields of the last sessions shown, by id. */
    val data = mutableStateMapOf<String, DockData>()
    private val recent = ArrayDeque<String>()

    var cards by mutableStateOf(emptySet<String>())
        private set
    var agentOpen by mutableStateOf<String?>(null)
        private set

    /** The task whose log is open, and its text. */
    var jobLog by mutableStateOf<Pair<String, String>?>(null)
        private set
    private var jobLogJob: Job? = null

    var ghOpen by mutableStateOf<String?>(null)
        private set
    val gh = mutableStateMapOf<String, Result<JsonElement?>>()
    val ghChecks = mutableStateMapOf<String, List<JsonElement>>()
    val ghDetails = mutableStateMapOf<String, Result<JsonElement>>()
    val ghDiffs = mutableStateMapOf<String, Result<JsonObject>>()
    private val ghLoading = mutableStateMapOf<String, Boolean>()
    var ghView by mutableStateOf<GhView?>(null)
        private set

    var run by mutableStateOf<RunWin?>(null)
        private set
    private var runPoll: Job? = null

    var image by mutableStateOf<ImageViewer?>(null)
        private set
    var agent by mutableStateOf<AgentViewer?>(null)
        private set

    /** Screenshot thumbnails by path; null while loading or when the file is gone. */
    val thumbs = mutableStateMapOf<String, ImageBitmap?>()

    /** The full-size picture the viewer shows. */
    var full by mutableStateOf<Pair<String, ImageBitmap?>?>(null)
        private set

    private var session: String? = null

    fun bind(c: HookedClient) {
        if (c === client) return
        client = c
        data.clear()
        recent.clear()
        keys.clear()
        lastAt.clear()
        pending.clear()
        gh.clear()
        ghChecks.clear()
        ghDetails.clear()
        ghDiffs.clear()
        ghLoading.clear()
        thumbs.clear()
    }

    /** A new session in the pane: its log stream stops, as rune's `select` drops `job_log`. */
    fun onSession(id: String) {
        if (session == id) return
        session = id
        jobLogJob?.cancel()
        jobLog = null
        val keep = data[id]?.sortedShots?.map { it.path }?.toSet().orEmpty()
        thumbs.keys.filter { it !in keep }.forEach { thumbs.remove(it) }
        data[id]?.let { prefetchGh(it.prLinks) }
        if (run?.owner != id) closeRun()
    }

    /** The dock left the screen: nothing keeps streaming or polling for it. */
    fun leave(id: String) {
        if (session != id) return
        jobLogJob?.cancel()
        jobLog = null
        if (run?.owner == id) closeRun()
    }

    private val pending = LinkedHashSet<String>()
    private val keys = HashMap<String, String?>()
    private val lastAt = HashMap<String, Long>()
    private var fetchJob: Job? = null
    private var fetching = false

    /**
     * Fetches a session's dock fields when `key` (the open detail's change key) moves on. The first detail
     * landing right after the dock's own fetch is not news, and fetches of one session are 5 s apart.
     */
    fun want(id: String, key: String?) {
        val known = keys.containsKey(id)
        val prev = keys[id]
        if (data.containsKey(id) && (key == null || (known && prev == key))) return
        keys[id] = key
        val fresh = (lastAt[id] ?: 0L) + REFRESH_MS > System.currentTimeMillis()
        if (known && prev == null && key != null && fresh) return
        pending += id
        // A loop waiting out another session's throttle restarts, so this one is not held behind it.
        if (fetchJob?.isActive == true) {
            if (fetching) return
            fetchJob?.cancel()
        }
        fetchJob = viewModelScope.launch {
            while (isActive && pending.isNotEmpty()) {
                val next = pending.minBy { lastAt[it] ?: 0L }
                val wait = (lastAt[next] ?: 0L) + REFRESH_MS - System.currentTimeMillis()
                if (wait > 0) delay(wait)
                pending.remove(next)
                val c = client ?: break
                lastAt[next] = System.currentTimeMillis()
                fetching = true
                try {
                    val d = c.dockData(next)
                    if (data[next] != d) data[next] = d
                    touch(next)
                    if (next == session) {
                        wantShots(next, d)
                        prefetchGh(d.prLinks)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                } finally {
                    fetching = false
                }
            }
        }
    }

    /** The open pane already holds the session body: read the dock from it instead of fetching again. */
    fun feed(id: String, d: DockData) {
        if (data[id] != d) data[id] = d
        touch(id)
        if (id == session) {
            wantShots(id, d)
            prefetchGh(d.prLinks)
        }
    }

    private fun touch(id: String) {
        recent.remove(id)
        recent.addLast(id)
        while (recent.size > KEEP_SESSIONS) data.remove(recent.removeFirst())
    }

    fun toggleCard(key: String) {
        cards = if (key in cards) cards - key else cards + key
        if (key == SHOTS) session?.let { id -> data[id]?.let { wantShots(id, it) } }
    }

    fun toggleAgent(id: String) {
        agentOpen = if (agentOpen == id) null else id
    }

    private fun wantShots(session: String, d: DockData) {
        val c = client ?: return
        val n = if (SHOTS in cards) DockData.SHOTS_OPEN else DockData.SHOTS_FOLDED
        for (shot in d.sortedShots.take(n)) {
            if (thumbs.containsKey(shot.path)) continue
            thumbs[shot.path] = null
            viewModelScope.launch {
                val img = runCatching {
                    val raw = c.bytes("api/screenshot", mapOf("session" to session, "path" to shot.path))
                    withContext(Dispatchers.Default) { decode(raw, THUMB_PX) }
                }.getOrNull()
                if (img != null && thumbs.containsKey(shot.path)) thumbs[shot.path] = img
            }
        }
    }

    fun openImage(session: String, paths: List<String>, index: Int) {
        image = ImageViewer(session, paths, index)
        paths.getOrNull(index)?.let { loadFull(session, it) }
    }

    fun stepImage(delta: Int) {
        val v = image ?: return
        val n = v.paths.size.coerceAtLeast(1)
        val i = ((v.index + delta) % n + n) % n
        image = v.copy(index = i)
        v.paths.getOrNull(i)?.let { loadFull(v.session, it) }
    }

    fun closeImage() {
        image = null
        full = null
    }

    private fun loadFull(session: String, path: String) {
        if (full?.first == path && full?.second != null) return
        full = path to thumbs[path]
        val c = client ?: return
        viewModelScope.launch {
            val img = runCatching {
                val raw = c.bytes("api/screenshot", mapOf("session" to session, "path" to path))
                withContext(Dispatchers.Default) { decode(raw, FULL_PX) }
            }.getOrNull()
            if (img != null && full?.first == path) full = path to img
        }
    }

    /** Streams a background job's output, keeping the last 64 KB; a second press closes it. */
    fun toggleJobLog(session: String, task: String) {
        jobLogJob?.cancel()
        if (jobLog?.first == task) {
            jobLog = null
            return
        }
        val c = client ?: return
        jobLog = task to ""
        jobLogJob = viewModelScope.launch {
            c.jobLog(session, task).collect { payload ->
                val bytes = runCatching { Base64.getDecoder().decode(payload) }.getOrNull()
                if (bytes == null || bytes.isEmpty()) return@collect
                val cur = jobLog
                if (cur?.first == task) jobLog = task to appendLog(cur.second, stripAnsi(String(bytes, Charsets.UTF_8)))
            }
        }
    }

    fun openAgent(session: String, agentId: String, title: String) {
        val c = client ?: return
        agent = AgentViewer(session, title, null)
        viewModelScope.launch {
            val list = runCatching { c.agentTranscript(session, agentId) }.getOrDefault(emptyList())
            if (agent?.title == title) agent = AgentViewer(session, title, list)
        }
    }

    fun closeAgent() {
        agent = null
    }

    // The Links card: an inline summary, then the widened detail.

    fun openGh(url: String) {
        if (ghOpen == url) {
            ghOpen = null
            return
        }
        ghOpen = url
        if ("/pull/" in url && !ghChecks.containsKey(url)) loadDetail(url)
        loadSummary(url)
    }

    /** The pull request pills read their state from the summaries, as the web dock tints them. */
    private fun prefetchGh(urls: List<String>) = urls.forEach(::loadSummary)

    private fun loadSummary(url: String) {
        if (gh.containsKey(url) || ghLoading["gh:$url"] == true) return
        val c = client ?: return
        ghLoading["gh:$url"] = true
        viewModelScope.launch {
            val r = try {
                Result.success(c.ghSummary(url))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            ghLoading.remove("gh:$url")
            gh[url] = r
        }
    }

    fun isLoading(url: String) = ghLoading[url] == true

    fun loadDetail(url: String, refresh: Boolean = false) {
        if (refresh) {
            ghDetails.remove(url)
            ghDiffs.remove(url)
        }
        if (ghDetails.containsKey(url) || ghLoading[url] == true) return
        val c = client ?: return
        ghLoading[url] = true
        viewModelScope.launch {
            val r = try {
                Result.success(c.ghDetail(url))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            ghLoading.remove(url)
            r.getOrNull()?.let { ghChecks[url] = it["checks"].arr }
            ghDetails[url] = r
            if (ghView?.let { it.url == url && it.tab == 2 } == true) loadDiff(url)
        }
    }

    private fun loadDiff(url: String) {
        val key = "diff:$url"
        if (ghDiffs.containsKey(url) || ghLoading[key] == true) return
        val c = client ?: return
        ghLoading[key] = true
        viewModelScope.launch {
            val r = try {
                Result.success(c.ghDiff(url))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            ghLoading.remove(key)
            ghDiffs[url] = r
        }
    }

    fun openGhFull(url: String, session: String) {
        loadDetail(url)
        ghView = GhView(url, session)
    }

    fun closeGhFull() {
        ghView = null
    }

    fun ghTab(tab: Int) {
        val v = ghView ?: return
        ghView = v.copy(tab = tab)
        if (tab == 2 && ghDetails[v.url]?.getOrNull()?.let { (it["kind"].str ?: "pr") == "pr" } == true) loadDiff(v.url)
    }

    fun ghRefresh() {
        val v = ghView ?: return
        loadDetail(v.url, refresh = true)
        if (v.tab == 2) loadDiff(v.url)
    }

    fun toggleFile(path: String) {
        val v = ghView ?: return
        ghView = v.copy(files = if (path in v.files) v.files - path else v.files + path)
    }

    fun toggleComment(key: String) {
        val v = ghView ?: return
        ghView = v.copy(comments = if (key in v.comments) v.comments - key else v.comments + key)
    }

    fun toggleBots() {
        ghView = ghView?.let { it.copy(bots = !it.bots) }
    }

    /** Asks the session to fix a failing check, with the same prompt as the web. */
    fun fixCheck(name: String, checkUrl: String) {
        val v = ghView ?: return
        val session = v.session ?: return
        val c = client ?: return
        val text = fixPrompt(name, checkUrl, v.url)
        ghView = v.copy(fixed = v.fixed + (name to Fix.SENDING))
        viewModelScope.launch {
            val ok = runCatching { c.reply(session, text) }.isSuccess
            ghView?.let { cur -> if (cur.url == v.url) ghView = cur.copy(fixed = cur.fixed + (name to if (ok) Fix.SENT else Fix.FAILED)) }
        }
    }

    // The run window, polled every 5 s while the run is going.

    /** `owner` is the session whose dock draws the window. */
    fun openRun(owner: String, url: String) {
        run = RunWin(owner, url, job = parseRunUrl(url)?.takeIf { it.isNotEmpty() })
        loadRun()
        runPoll?.cancel()
        runPoll = viewModelScope.launch {
            while (isActive) {
                delay(1_000)
                val w = run ?: break
                if (w.url != url) break
                if (!w.loading && System.currentTimeMillis() - w.polled > RUN_POLL_MS && (w.run == null || w.run.status == "pending")) loadRun()
            }
        }
    }

    fun closeRun() {
        runPoll?.cancel()
        run = null
    }

    fun pickRunJob(id: String) {
        run = run?.copy(job = id)
        loadRunLog()
    }

    private fun loadRun() {
        val w = run ?: return
        if (w.loading) return
        val c = client ?: return
        run = w.copy(loading = true, polled = System.currentTimeMillis())
        viewModelScope.launch {
            val r = try {
                Result.success(c.ghRun(w.url))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            val cur = run?.takeIf { it.url == w.url } ?: return@launch
            run = r.fold({ cur.copy(run = it, err = null, loading = false) }, { cur.copy(err = it.message, loading = false) })
            loadRunLog()
        }
    }

    private fun loadRunLog() {
        val w = run ?: return
        val job = w.run?.job(w.job) ?: return
        val have = w.log
        if (have != null && have.first == job.id && have.second.getOrNull() != null) return
        if (have != null && have.first == job.id && have.second.isFailure) return
        if (job.status == "pending") {
            run = w.copy(log = job.id to Result.success(null))
            return
        }
        val c = client ?: return
        viewModelScope.launch {
            val r = try {
                Result.success(c.ghJobLog(job.url))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            run = run?.copy(log = job.id to r)
        }
    }

    companion object {
        const val SHOTS = "dock-shots"
        private const val REFRESH_MS = 5_000L
        private const val KEEP_SESSIONS = 8
        private const val RUN_POLL_MS = 5_000L
        private const val THUMB_PX = 400
        private const val FULL_PX = 2400

        /** Decodes at the smallest power-of-two reduction still at least `maxSide` on its long side. */
        private fun decode(raw: ByteArray, maxSide: Int): ImageBitmap? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
            if (bounds.outWidth <= 0) return null
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
            val bmp: Bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            return bmp.asImageBitmap()
        }
    }
}
