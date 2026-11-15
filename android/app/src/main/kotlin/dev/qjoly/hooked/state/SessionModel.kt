package dev.qjoly.hooked.state

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.scale
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.LiveSnapshot
import dev.qjoly.hooked.data.SessionDetail
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.data.fork
import dev.qjoly.hooked.data.fullMessage
import dev.qjoly.hooked.data.openEditor
import dev.qjoly.hooked.data.projectFiles
import dev.qjoly.hooked.data.restart
import dev.qjoly.hooked.data.sessionRaw
import dev.qjoly.hooked.data.slashCommands
import dev.qjoly.hooked.data.sseFlow
import dev.qjoly.hooked.data.trash
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.io.ByteArrayOutputStream

class Attachment(val key: Long, val thumbnail: ImageBitmap, val path: String? = null, val failed: Boolean = false, val name: String = "image")

/** A model switch the server held because the prompt cache is warm. */
data class HeldSwitch(val model: String?, val effort: String?, val impact: JsonObject)

/** A message sent but not in the transcript yet; `after` is the message count when it left. */
data class Queued(val text: String, val after: Int, val id: Long = System.nanoTime())

/** One open conversation: its transcript, the turn in progress and every control. */
class SessionModel(val id: String, private val client: HookedClient) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var detail by mutableStateOf<SessionDetail?>(null)
        private set

    /** The same fetch read the way rune's conversation view needs it. */
    var conversation by mutableStateOf<Conversation?>(null)
        private set

    /** The raw /api/session body, for lenses that read more of it. */
    var raw by mutableStateOf<JsonElement?>(null)
        private set
    var snapshot by mutableStateOf<LiveSnapshot?>(null)
        private set
    var loadError by mutableStateOf<String?>(null)
        private set
    var actionError by mutableStateOf<String?>(null)
    var sending by mutableStateOf(false)
        private set

    val queued = mutableStateListOf<Queued>()

    /** Kept for callers of the first port: the last message still on its way. */
    val outgoing: String? get() = queued.lastOrNull()?.text
    val attachments = mutableStateListOf<Attachment>()
    var heldSwitch by mutableStateOf<HeldSwitch?>(null)

    /** When the current turn started, for the working line's clock. */
    var workingSince by mutableStateOf<Long?>(null)
        private set

    /** Full texts of truncated user messages by fork uuid; null while loading. */
    val fullTexts = mutableStateMapOf<String, String?>()

    /** Success lines ("✓ …") for the top bar flash. */
    var say: (String) -> Unit = {}

    private var loading = false
    private var reloadAgain = false
    private var streamJob: Job? = null
    private var pollJob: Job? = null

    val isLive get() = detail?.session?.live ?: false
    val isBusy get() = snapshot?.busy == true || detail?.session?.state == SessionState.WORKING

    fun start() {
        scope.launch { load() }
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                delay(5_000)
                if (isBusy || queued.isNotEmpty()) load()
            }
        }
    }

    fun stop() {
        streamJob?.cancel()
        streamJob = null
        pollJob?.cancel()
        pollJob = null
        snapshot = null
    }

    fun close() = scope.cancel()

    /** Refetches the detail; calls made while a fetch is in flight collapse into one more fetch. */
    suspend fun load() {
        if (loading) {
            reloadAgain = true
            return
        }
        loading = true
        try {
            do {
                reloadAgain = false
                try {
                    val j = client.sessionRaw(id)
                    val d = SessionDetail.of(j)
                    val c = Conversation.of(j)
                    raw = j
                    if (d != detail) detail = d
                    if (c != conversation) conversation = c
                    loadError = null
                    settleQueue(c)
                    syncWorking()
                    if (d.session.live && streamJob == null && pollJob != null) openStream()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    loadError = e.message
                }
            } while (reloadAgain)
        } finally {
            loading = false
        }
    }

    private fun settleQueue(c: Conversation) {
        queued.removeAll { q ->
            val t = q.text.trim()
            c.turns.drop(q.after).any { it.user && (it.text.trim() == t || it.text.contains(t)) }
        }
    }

    private fun syncWorking() {
        if (isBusy) {
            if (workingSince == null) workingSince = System.currentTimeMillis()
        } else {
            workingSince = null
        }
    }

    private fun openStream() {
        streamJob = scope.launch {
            try {
                sseFlow(client.url("api/session/stream", mapOf("id" to id))).collect { payload ->
                    val snap = LiveSnapshot.of(runCatching { Json.parseToJsonElement(payload) }.getOrNull())
                    if (!snap.live || snap.ended) {
                        snapshot = null
                        scope.launch { load() }
                        throw StreamDone()
                    }
                    val prev = snapshot
                    snapshot = snap
                    syncWorking()
                    // A finished turn or a new pending question lands in the transcript: fetch it.
                    if ((prev?.busy == true && !snap.busy) || (snap.state != prev?.state && snap.state == "requires_action")) {
                        scope.launch { load() }
                    }
                }
            } catch (_: StreamDone) {
            } finally {
                streamJob = null
            }
        }
    }

    private class StreamDone : CancellationException()

    private suspend fun attempt(body: suspend () -> Unit): Boolean = try {
        body()
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        actionError = e.message
        false
    }

    private fun act(busy: Boolean = true, done: String? = null, body: suspend () -> Unit) {
        scope.launch {
            if (busy) sending = true
            try {
                if (attempt(body)) {
                    done?.let(say)
                    load()
                }
            } finally {
                if (busy) sending = false
            }
        }
    }

    /** Sends a reply, or resumes the session with it when it is not running. Returns false when nothing went out. */
    suspend fun send(text: String): Boolean {
        val paths = attachments.mapNotNull { it.path }
        val message = (paths + text.trim()).filter { it.isNotEmpty() }.joinToString(" ")
        if (message.isEmpty() || sending) return false
        if (attachments.any { it.path == null && !it.failed }) {
            actionError = "Wait for the images to finish uploading."
            return false
        }
        attachments.clear()
        return sendPrompt(message)
    }

    /** A message as is: a suggestion, a code block to run. */
    suspend fun sendPrompt(message: String): Boolean {
        if (sending) return false
        sending = true
        val q = Queued(message, conversation?.turns?.size ?: 0)
        queued += q
        try {
            val live = isLive
            val effort = detail?.session?.effort
            val ok = attempt { if (live) client.reply(id, message) else client.resume(id, message, effort) }
            if (!ok) queued.remove(q)
            load()
            return ok
        } finally {
            sending = false
        }
    }

    fun sendLater(message: String) {
        scope.launch { sendPrompt(message) }
    }

    fun resume() = act(done = "✓ Resumed") { client.resume(id, "", detail?.session?.effort) }

    fun answer(selections: List<HookedClient.Selection>, note: String? = null, done: String = "✓ Answered") =
        act(done = done) { client.answer(id, selections, note) }

    fun plan(action: String, feedback: String? = null) =
        act(done = if (action.startsWith("keep")) "✓ Plan rejected" else "✓ Plan approved") { client.plan(id, action, feedback) }

    fun interrupt() = act(busy = false, done = "✓ Interrupted") { client.interrupt(id) }

    fun kill() = act(busy = false) { client.kill(id) }

    fun setMode(mode: String) = act(busy = false, done = "✓ ${modeLabel(mode)}") { client.setMode(id, mode) }

    fun setAutoApprove(on: Boolean) = act(busy = false, done = if (on) "✓ Auto-approve on" else "✓ Auto-approve off") { client.setAutoApprove(id, on) }

    fun setModel(model: String?, effort: String?, force: Boolean = false) {
        scope.launch {
            var impact: JsonObject? = null
            if (!attempt { impact = client.setModel(id, model, effort, force) }) return@launch
            val held = impact
            if (held != null) {
                heldSwitch = HeldSwitch(model, effort, held)
            } else {
                say("✓ Model updated")
                load()
            }
        }
    }

    fun restart() = act(busy = false, done = "✓ Restarted") { client.restart(id) }

    fun openEditor() = act(busy = false, done = "✓ Opened in editor") { client.openEditor(id) }

    /** Moves the session to the trash, then hands control back. */
    fun trash(onDone: () -> Unit) {
        scope.launch {
            if (attempt { client.trash(id) }) {
                say("✓ Moved to trash")
                onDone()
            }
        }
    }

    /** Forks at a message; `onDone` gets the new session id. */
    fun fork(uuid: String, prompt: String, model: String?, effort: String?, mode: String?, onDone: (String) -> Unit) {
        say("⑂ Forking…")
        scope.launch {
            var newId: String? = null
            if (attempt { newId = client.fork(id, uuid, prompt, model, effort, mode) }) {
                say("✓ Forked into a new session")
                newId?.let(onDone)
            }
        }
    }

    /** A shell block of the conversation, run in the session as a `!` command. */
    fun runCode(code: String) {
        scope.launch {
            if (attempt { client.reply(id, "!" + code.trim()) }) say("✓ Running in the session")
            load()
        }
    }

    fun loadFullText(uuid: String) {
        if (uuid in fullTexts) return
        fullTexts[uuid] = null
        scope.launch {
            val t = runCatching { client.fullMessage(id, uuid) }.getOrNull()
            if (t == null) {
                fullTexts.remove(uuid)
                actionError = "Could not load the full message"
            } else {
                fullTexts[uuid] = t
            }
        }
    }

    /** Completion items for the text before the caret, or empty. */
    suspend fun complete(q: AcQuery): List<AcItem> = try {
        when (q) {
            is AcQuery.Command -> acItems(client.slashCommands(id, q.q), files = false)
            is AcQuery.File -> acItems(client.projectFiles(id, q.q), files = true)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        emptyList()
    }

    fun refresh() {
        scope.launch { load() }
    }

    /** Downscales the image, uploads it, and keeps its server path for the next message. */
    fun attach(ctx: Context, uri: Uri) {
        val key = System.nanoTime()
        scope.launch {
            val name = withContext(Dispatchers.IO) { displayName(ctx, uri) }
            val bitmap = withContext(Dispatchers.IO) { decode(ctx, uri, 2000) } ?: run {
                actionError = "Could not read that image."
                return@launch
            }
            val thumb = bitmap.scale(160, (160f * bitmap.height / bitmap.width).toInt().coerceAtLeast(1))
            attachments += Attachment(key, thumb.asImageBitmap(), name = name)
            val path = withContext(Dispatchers.IO) {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
                val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                runCatching { client.uploadImage(b64) }
            }
            val i = attachments.indexOfFirst { it.key == key }
            if (i < 0) return@launch
            attachments[i] = Attachment(key, attachments[i].thumbnail, path.getOrNull(), path.isFailure, name)
            path.exceptionOrNull()?.let { actionError = "Upload failed: ${it.message}" }
        }
    }

    private fun displayName(ctx: Context, uri: Uri): String = runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "image"

    private fun decode(ctx: Context, uri: Uri, maxSide: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        val decoded = ctx.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: return null
        val side = maxOf(decoded.width, decoded.height)
        if (side <= maxSide) return decoded
        val scale = maxSide.toFloat() / side
        return decoded.scale((decoded.width * scale).toInt(), (decoded.height * scale).toInt())
    }
}
