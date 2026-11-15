package dev.qjoly.hooked.ui.terminal

import androidx.compose.runtime.LaunchedEffect
import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.RememberObserver
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.edit
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.HookedException
import dev.qjoly.hooked.data.TermStreamEvent
import dev.qjoly.hooked.data.killTerminal
import dev.qjoly.hooked.data.openTerminal
import dev.qjoly.hooked.data.resizeTerminal
import dev.qjoly.hooked.data.terminalInput
import dev.qjoly.hooked.data.terminalStream
import dev.qjoly.hooked.data.terminals
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The scrollback search: what is typed, its hits (newest first) and the one shown. */
data class TermSearch(val query: String = "", val hits: List<Hit> = emptyList(), val index: Int? = null) {
    val label: String
        get() = when {
            hits.isEmpty() && query.isEmpty() -> ""
            hits.isEmpty() -> "no match"
            index != null -> "${index + 1}/${hits.size}"
            else -> "${hits.size}"
        }
}

/**
 * A session's shells, as rune's `TermPanel`: the attached terminals and the active one, the shared
 * grid size, selection, search and the extra keys' latched modifiers. One per session, shared by the
 * drawer and the panel, and kept while either is on screen.
 */
class TermDeck internal constructor(val sessionId: String, private val client: HookedClient, private val prefs: SharedPreferences) : TermSink {
    val terms = mutableStateListOf<Term>()
    var active by mutableIntStateOf(0)
    var busy by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set
    var sel by mutableStateOf<Sel?>(null)

    /** Where the selection's actions show: after a long press, a handle drag or a right click. */
    var menuAt by mutableStateOf<CellPos?>(null)
    var selLink by mutableStateOf<String?>(null)
    var search by mutableStateOf<TermSearch?>(null)
    var ctrl by mutableStateOf(false)
    var alt by mutableStateOf(false)
    var preedit by mutableStateOf("")
    var focused by mutableStateOf(false)
    var font by mutableFloatStateOf(loadFont())
        private set

    /** The drawer height in dp; null until the user drags it. */
    var height by mutableStateOf(prefs.getFloat("termHeight", 0f).takeIf { it > 0f })
        private set

    var say: (String) -> Unit = {}
    var copyText: (String) -> Unit = {}

    /** The grid every shell of the panel shares, once the screen was measured. */
    var size: Pair<Int, Int>? = null
        private set
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var started = 0
    private var loading = false

    /** The last load failed; the next start tries again. */
    private var stale = false
    private var resizeJob: Job? = null
    internal var holders = 0

    /** A dead key waiting for the letter it accents. */
    internal var accent = 0
    internal var fling: Job? = null

    val current: Term? get() = terms.getOrNull(active)

    // ── TermSink ───────────────────────────────────────────────────────────────────────────────

    override fun input(t: Term, data: String) = send(t, data)

    override fun copy(text: String) = copyText(text)

    override fun scrolled(t: Term, rows: Int) {
        if (t != current) return
        sel = sel?.shifted(rows)
        menuAt = menuAt?.let { it.copy(row = it.row - rows) }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────

    /** Streams run while some holder is started: the app in the foreground with the session open. */
    fun start() {
        if (started++ > 0) return
        if (!loaded || stale) load()
        terms.forEach(::follow)
    }

    fun stop() {
        if (--started > 0) return
        terms.forEach { it.stream?.cancel(); it.stream = null }
    }

    internal fun dispose() {
        scope.cancel()
        terms.clear()
    }

    /** Reattaches the session's shells, inline `!!` ones left to the conversation. */
    private fun load() {
        if (loading) return
        loading = true
        scope.launch {
            try {
                val list = client.terminals(sessionId).filter { !it.inline }
                for (info in list) {
                    if (terms.any { it.id == info.id }) continue
                    val t = attach(info.id, fresh = false)
                    t.exited = info.exited
                    val s = size
                    if (!info.exited && s != null && (info.cols != s.first || info.rows != s.second)) postResize(listOf(t), s)
                }
                stale = false
            } catch (_: Exception) {
                stale = true
            } finally {
                loading = false
                loaded = true
            }
        }
    }

    private fun attach(id: String, fresh: Boolean): Term {
        val (cols, rows) = size ?: (COLS to ROWS)
        val t = Term(id, cols, rows, this, fresh)
        terms += t
        if (started > 0) follow(t)
        return t
    }

    private fun follow(t: Term) {
        t.stream?.cancel()
        t.stream = scope.launch {
            var replay = false
            client.terminalStream(t.id).collect { ev ->
                when (ev) {
                    TermStreamEvent.Attached -> {
                        // Every connection replays the whole buffer, so it lands on a blank screen.
                        val reconnect = t.fed
                        if (reconnect) {
                            t.reset()
                            if (t == current) clearSel()
                        }
                        replay = !t.fresh || reconnect
                    }
                    is TermStreamEvent.Output -> {
                        if (replay) {
                            replay = false
                            t.replay(ev.bytes)
                        } else {
                            t.feed(ev.bytes)
                            if (ev.bytes.size < 200 && String(ev.bytes, Charsets.UTF_8).contains("[process exited")) confirmExit(t)
                        }
                    }
                }
            }
            // The server ended the stream: the shell was closed, or hooked restarted.
            t.exited = true
        }
    }

    /** The server's exit notice is plain text; the list says for sure. */
    private fun confirmExit(t: Term) {
        scope.launch {
            runCatching { client.terminals(sessionId) }.getOrNull()?.firstOrNull { it.id == t.id }?.let { if (it.exited) t.exited = true }
        }
    }

    // ── Shells ─────────────────────────────────────────────────────────────────────────────────

    /** rune's `new_term`: a shell in the session's project, made active. */
    fun newTerm(project: String?, onOpened: () -> Unit = {}, onFailed: () -> Unit = {}) {
        if (busy) return
        if (project == null) {
            say("✗ This session has no project folder")
            onFailed()
            return
        }
        busy = true
        val (cols, rows) = size ?: (COLS to ROWS)
        scope.launch {
            try {
                val info = client.openTerminal(project, sessionId, cols, rows)
                val t = attach(info.id, fresh = true)
                pick(terms.indexOf(t))
                onOpened()
            } catch (e: Exception) {
                say("✗ Terminal: ${e.message}")
                onFailed()
            } finally {
                busy = false
            }
        }
    }

    fun pick(i: Int) {
        if (i !in terms.indices) return
        if (i != active) clearSel()
        active = i
        search = null
    }

    /** Kills the shell; false once none is left. */
    fun close(i: Int): Boolean {
        val t = terms.getOrNull(i) ?: return terms.isNotEmpty()
        terms.removeAt(i)
        t.stream?.cancel()
        if (i < active) active--
        active = active.coerceAtMost((terms.size - 1).coerceAtLeast(0))
        clearSel()
        search = null
        Background.launch { runCatching { client.killTerminal(t.id) } }
        return terms.isNotEmpty()
    }

    fun restart(i: Int, project: String?, onFailed: () -> Unit = {}) {
        close(i)
        newTerm(project, onFailed = onFailed)
    }

    // ── Size ───────────────────────────────────────────────────────────────────────────────────

    /** The grid changed: every emulator follows at once, the PTYs 150 ms after the last change. */
    fun fit(cols: Int, rows: Int) {
        val s = cols to rows
        if (size == s) return
        size = s
        terms.forEach { it.resize(cols, rows) }
        clearSel()
        resizeJob?.cancel()
        resizeJob = scope.launch {
            delay(150)
            postResize(terms.filter { !it.exited }, s)
        }
    }

    private fun postResize(list: List<Term>, s: Pair<Int, Int>) {
        list.forEach { t -> scope.launch { runCatching { client.resizeTerminal(t.id, s.first, s.second) } } }
    }

    /** rune's `zoom_term`: one point per step, 0 back to the default. */
    fun zoom(step: Int) = setFont(if (step == 0) FONT else font + step, save = true)

    fun setFont(size: Float, save: Boolean) {
        font = size.coerceIn(FONT_MIN, FONT_MAX)
        if (save) saveFont(font)
    }

    /** Writes the size to the app-wide setting the Settings page shows. */
    var storeFont: (Float) -> Unit = {}

    private fun loadFont() = prefs.getFloat("termFont", FONT).coerceIn(FONT_MIN, FONT_MAX)

    private fun saveFont(size: Float) = storeFont(size)

    fun saveHeight(dp: Float) {
        height = dp
        prefs.edit { putFloat("termHeight", dp) }
    }

    fun dragHeight(dp: Float) {
        height = dp
    }

    // ── Input ──────────────────────────────────────────────────────────────────────────────────

    /** Queues bytes for the shell; one request at a time keeps them in order. */
    fun send(t: Term, data: String) {
        if (t.exited || data.isEmpty()) return
        t.queue.addLast(data)
        if (t.sending) return
        t.sending = true
        scope.launch {
            try {
                while (true) {
                    val batch = nextBatch(t.queue) ?: break
                    try {
                        client.terminalInput(t.id, batch)
                    } catch (e: HookedException) {
                        if (e.message.orEmpty().let { "exited" in it || "unknown terminal" in it }) {
                            t.exited = true
                            t.queue.clear()
                        }
                    }
                }
            } finally {
                t.sending = false
            }
        }
    }

    /** Typed input for the active shell, which comes back to the bottom as rune's does. */
    fun type(data: String) {
        val t = current ?: return
        if (t.exited) return
        t.scrollToBottom()
        send(t, data)
    }

    /** Soft-keyboard text, with the latched modifiers applied and released. */
    fun typeText(text: String) {
        if (text.isEmpty()) return
        type(encodeTyped(text, ctrl, alt))
        ctrl = false
        alt = false
    }

    /** A special key through Termux's encoder, latched modifiers included. */
    fun typeKey(keyCode: Int, ctrl: Boolean = false, alt: Boolean = false, shift: Boolean = false): Boolean {
        val t = current ?: return false
        val code = t.keyCode(keyCode, keyMod(ctrl || this.ctrl, alt || this.alt, shift)) ?: return false
        this.ctrl = false
        this.alt = false
        type(code)
        return true
    }

    fun paste(text: String) {
        val t = current ?: return
        if (t.exited || text.isEmpty()) return
        t.scrollToBottom()
        t.paste(text)
    }

    // ── Selection ──────────────────────────────────────────────────────────────────────────────

    fun clearSel() {
        sel = null
        menuAt = null
        selLink = null
    }

    fun selectionText(): String? = sel?.let { s -> current?.selectedText(s) }

    /** The word under a long press, or nothing on a blank; the menu shows either way. */
    fun selectWord(t: Term, col: Int, row: Int) {
        val w = t.wordAt(col, row)
        sel = w?.let { (a, b) -> Sel(CellPos(a, row), CellPos(b, row)) }
        selLink = t.linkAt(col, row)
        menuAt = null
    }

    fun copySelection(): Boolean {
        val text = selectionText() ?: return false
        copyText(text)
        clearSel()
        return true
    }

    // ── Search ─────────────────────────────────────────────────────────────────────────────────

    fun openSearch() {
        if (search == null) search = TermSearch()
    }

    fun closeSearch() {
        search = null
        current?.scrollToBottom()
    }

    fun searchChanged(q: String) {
        val t = current ?: return
        val hits = t.search(q)
        search = TermSearch(q, hits, if (hits.isEmpty()) null else 0)
        hits.firstOrNull()?.let { t.reveal(it.row) }
    }

    /** The next match toward older output (`older`) or newer, scrolling to it. */
    fun searchStep(older: Boolean) {
        val t = current ?: return
        val s = search ?: return
        val hits = t.search(s.query)
        if (hits.isEmpty()) {
            search = s.copy(hits = hits, index = null)
            return
        }
        val i = when (val at = s.index) {
            null -> 0
            else -> (if (older) at + 1 else at - 1).mod(hits.size)
        }
        search = s.copy(hits = hits, index = i)
        t.reveal(hits[i].row)
    }

    companion object {
        const val COLS = 120
        const val ROWS = 28
        const val FONT = 12f
        const val FONT_MIN = 8f
        const val FONT_MAX = 28f
    }
}

/** Fire-and-forget calls that must outlive a deck, like the kill of a closed shell. */
private val Background = CoroutineScope(SupervisorJob() + Dispatchers.IO)

/** The decks on screen, one per session, refcounted by their holders. */
internal object TermDecks {
    private val decks = HashMap<String, TermDeck>()

    fun get(client: HookedClient, sessionId: String, ctx: Context): TermDeck {
        val key = "${System.identityHashCode(client)}:$sessionId"
        return decks.getOrPut(key) { TermDeck(sessionId, client, ctx.getSharedPreferences("terminal", Context.MODE_PRIVATE)) }
    }

    fun retain(deck: TermDeck) {
        deck.holders++
    }

    fun release(deck: TermDeck) {
        if (--deck.holders > 0) return
        decks.entries.removeAll { it.value === deck }
        deck.dispose()
    }

    fun abandon(deck: TermDeck) {
        if (deck.holders > 0) return
        decks.entries.removeAll { it.value === deck }
        deck.dispose()
    }
}

private class DeckHandle(val deck: TermDeck) : RememberObserver {
    override fun onRemembered() = TermDecks.retain(deck)
    override fun onForgotten() = TermDecks.release(deck)
    override fun onAbandoned() = TermDecks.abandon(deck)
}

/** The session's deck, streaming while this call site is shown and the app is in the foreground. */
@Composable
internal fun rememberTermDeck(app: AppModel, client: HookedClient, sessionId: String): TermDeck {
    val ctx = LocalContext.current
    // Before any shell is made, so new emulators start from these defaults.
    TermPalette.install(k.dark)
    val deck = remember(client, sessionId) { DeckHandle(TermDecks.get(client, sessionId, ctx)) }.deck
    deck.say = app::say
    deck.storeFont = app.prefs::termFont
    // The Settings page's size, followed live; pinch and ⌘± write it back.
    val font = app.prefs.termFont
    LaunchedEffect(deck, font) { deck.setFont(font, save = false) }
    deck.copyText = { copyToClipboard(ctx, it) }
    LifecycleStartEffect(deck) {
        deck.start()
        onStopOrDispose { deck.stop() }
    }
    return deck
}
