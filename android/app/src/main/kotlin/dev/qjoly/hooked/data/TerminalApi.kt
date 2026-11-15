package dev.qjoly.hooked.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

// hooked's shells (server/terminal.js): real PTYs in the hooked process, tagged with a session but
// independent of it. Output comes back over SSE as base64 PTY bytes, keystrokes go out as plain strings.

/** One terminal as `describe()` serializes it. */
data class TermInfo(
    val id: String,
    val cwd: String?,
    val sessionId: String?,
    val inline: Boolean,
    val cols: Int?,
    val rows: Int?,
    val exited: Boolean,
    val exitCode: Int?,
) {
    companion object {
        fun of(j: JsonElement?) = TermInfo(
            j["id"].str.orEmpty(), j["cwd"].text, j["sessionId"].text, j["inline"].bool,
            j["cols"].int, j["rows"].int, j["exited"].bool, j["exitCode"].int,
        )
    }
}

/** The session's terminals, inline `!!` ones included (callers drop them from the panel). */
suspend fun HookedClient.terminals(sessionId: String): List<TermInfo> =
    get("api/terminal", mapOf("sessionId" to sessionId))["terminals"].arr.map(TermInfo::of).filter { it.id.isNotEmpty() }

/** A login shell in `cwd`; `sessionId` only labels it. */
suspend fun HookedClient.openTerminal(cwd: String, sessionId: String, cols: Int, rows: Int): TermInfo =
    TermInfo.of(post("api/terminal", body("cwd" to cwd, "sessionId" to sessionId, "cols" to cols, "rows" to rows)))
        .takeIf { it.id.isNotEmpty() } ?: throw HookedException("The shell did not start")

suspend fun HookedClient.terminalInput(id: String, data: String) {
    post("api/terminal/input", body("id" to id, "data" to data))
}

suspend fun HookedClient.resizeTerminal(id: String, cols: Int, rows: Int) {
    post("api/terminal/resize", body("id" to id, "cols" to cols, "rows" to rows))
}

suspend fun HookedClient.killTerminal(id: String) {
    post("api/terminal/kill", body("id" to id))
}

sealed interface TermStreamEvent {
    /** A connection opened; the server replays its screen buffer first. */
    data object Attached : TermStreamEvent

    class Output(val bytes: ByteArray) : TermStreamEvent
}

/** The base64 payload of an SSE `data:` line, decoded; null for comments, `retry:` and garbage. */
fun sseBytes(line: String): ByteArray? {
    if (!line.startsWith("data:")) return null
    val b64 = line.substring(5).trim()
    if (b64.isEmpty()) return null
    return try {
        Base64.getDecoder().decode(b64)
    } catch (_: IllegalArgumentException) {
        null
    }
}

/**
 * A terminal's output. Reconnects after a network error (each connection starts with a replay),
 * and completes once the server ends the stream or no longer knows the id: the terminal is gone.
 */
fun HookedClient.terminalStream(id: String): Flow<TermStreamEvent> = channelFlow {
    while (isActive) {
        val c = URL(url("api/terminal/stream", mapOf("id" to id))).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000
        // Three missed 15 s heartbeats mean a dead connection.
        c.readTimeout = 45_000
        c.setRequestProperty("Accept", "text/event-stream")
        var gone = false
        val reader = launch(Dispatchers.IO) {
            try {
                when (c.responseCode) {
                    in 200..299 -> {}
                    404 -> {
                        gone = true
                        return@launch
                    }
                    else -> return@launch
                }
                send(TermStreamEvent.Attached)
                c.inputStream.bufferedReader().use { r ->
                    while (true) {
                        val line = r.readLine() ?: break
                        sseBytes(line)?.let { send(TermStreamEvent.Output(it)) }
                    }
                }
                gone = true
            } catch (_: IOException) {
            }
        }
        // Cancelling the collector lands here: disconnecting unblocks the read.
        try {
            reader.join()
        } finally {
            c.disconnect()
        }
        if (gone) break
        delay(2_000)
    }
}
