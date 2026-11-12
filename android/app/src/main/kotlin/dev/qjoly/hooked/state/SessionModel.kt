package dev.qjoly.hooked.state

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.scale
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.LiveSnapshot
import dev.qjoly.hooked.data.SessionDetail
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.data.sseFlow
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
import kotlinx.serialization.json.JsonObject
import java.io.ByteArrayOutputStream

class Attachment(val key: Long, val thumbnail: ImageBitmap, val path: String? = null, val failed: Boolean = false)

/** A model switch the server held because the prompt cache is warm. */
data class HeldSwitch(val model: String?, val effort: String?, val impact: JsonObject)

/** One open conversation: its transcript, the turn in progress and every control. */
class SessionModel(val id: String, private val client: HookedClient) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var detail by mutableStateOf<SessionDetail?>(null)
        private set
    var snapshot by mutableStateOf<LiveSnapshot?>(null)
        private set
    var loadError by mutableStateOf<String?>(null)
        private set
    var actionError by mutableStateOf<String?>(null)
    var sending by mutableStateOf(false)
        private set

    /** Sent text not yet seen in the transcript, shown as a queued bubble. */
    var outgoing by mutableStateOf<String?>(null)
        private set
    val attachments = mutableStateListOf<Attachment>()
    var heldSwitch by mutableStateOf<HeldSwitch?>(null)

    private var loading = false
    private var reloadAgain = false
    private var streamJob: Job? = null
    private var pollJob: Job? = null

    val isLive get() = detail?.session?.live ?: false
    val isBusy get() = snapshot?.busy ?: (detail?.session?.state == SessionState.WORKING)

    fun start() {
        scope.launch { load() }
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                delay(5_000)
                if (isBusy) load()
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
                    val d = client.detail(id)
                    if (d != detail) detail = d
                    loadError = null
                    val o = outgoing
                    if (o != null && d.messages.any { it.role == "user" && it.text.contains(o) }) outgoing = null
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

    private fun act(busy: Boolean = true, body: suspend () -> Unit) {
        scope.launch {
            if (busy) sending = true
            try {
                if (attempt(body)) load()
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
        sending = true
        try {
            val live = isLive
            val effort = detail?.session?.effort
            val ok = attempt { if (live) client.reply(id, message) else client.resume(id, message, effort) }
            if (ok) {
                attachments.clear()
                outgoing = message
                load()
            }
            return ok
        } finally {
            sending = false
        }
    }

    fun resume() = act { client.resume(id, "", detail?.session?.effort) }

    fun answer(selections: List<HookedClient.Selection>, note: String? = null) = act { client.answer(id, selections, note) }

    fun plan(action: String, feedback: String? = null) = act { client.plan(id, action, feedback) }

    fun interrupt() = act(busy = false) { client.interrupt(id) }

    fun kill() = act(busy = false) { client.kill(id) }

    fun setMode(mode: String) = act(busy = false) { client.setMode(id, mode) }

    fun setAutoApprove(on: Boolean) = act(busy = false) { client.setAutoApprove(id, on) }

    fun setModel(model: String?, effort: String?, force: Boolean = false) {
        scope.launch {
            var impact: JsonObject? = null
            if (!attempt { impact = client.setModel(id, model, effort, force) }) return@launch
            val held = impact
            if (held != null) heldSwitch = HeldSwitch(model, effort, held) else load()
        }
    }

    fun refresh() {
        scope.launch { load() }
    }

    /** Downscales the image, uploads it, and keeps its server path for the next message. */
    fun attach(ctx: Context, uri: Uri) {
        val key = System.nanoTime()
        scope.launch {
            val bitmap = withContext(Dispatchers.IO) { decode(ctx, uri, 2000) } ?: run {
                actionError = "Could not read that image."
                return@launch
            }
            val thumb = bitmap.scale(160, (160f * bitmap.height / bitmap.width).toInt().coerceAtLeast(1))
            attachments += Attachment(key, thumb.asImageBitmap())
            val path = withContext(Dispatchers.IO) {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
                val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                runCatching { client.uploadImage(b64) }
            }
            val i = attachments.indexOfFirst { it.key == key }
            if (i < 0) return@launch
            attachments[i] = Attachment(key, attachments[i].thumbnail, path.getOrNull(), path.isFailure)
            path.exceptionOrNull()?.let { actionError = it.message }
        }
    }

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
