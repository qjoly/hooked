package dev.qjoly.hooked.data.dock

import android.util.JsonReader
import android.util.JsonToken
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.HookedException
import dev.qjoly.hooked.data.Message
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.obj
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// The endpoints the session context dock reads, as rune's api.rs, ghdetail.rs and ghrun.rs call them.

private val KEEP = setOf("todos", "subagents", "subSessions", "bgJobs", "prLinks", "issueLinks", "screenshots")
private val PICK = mapOf(
    "changes" to setOf("file", "name", "ops"),
    "workflows" to setOf("name", "status", "doneCount", "agentCount"),
)

/**
 * The dock's fields of GET /api/session. The response runs to megabytes (messages, and file contents in
 * `changes`), so it is streamed and only the fields the dock reads are kept.
 */
suspend fun HookedClient.dockData(id: String): DockData = withContext(Dispatchers.IO) {
    val c = URL(url("api/session", mapOf("id" to id))).openConnection() as HttpURLConnection
    try {
        c.connectTimeout = 10_000
        c.readTimeout = 30_000
        c.setRequestProperty("Accept", "application/json")
        val code = c.responseCode
        if (code !in 200..299) throw HookedException("Server error ($code)")
        JsonReader(c.inputStream.bufferedReader()).use { DockData.of(readDock(it)) }
    } catch (e: IOException) {
        throw HookedException(e.message ?: "Connection failed")
    } finally {
        c.disconnect()
    }
}

private fun readDock(r: JsonReader): JsonObject {
    val out = LinkedHashMap<String, JsonElement>()
    r.beginObject()
    while (r.hasNext()) {
        val name = r.nextName()
        val pick = PICK[name]
        when {
            name in KEEP -> out[name] = readValue(r)
            pick != null && r.peek() == JsonToken.BEGIN_ARRAY -> out[name] = readPicked(r, pick)
            else -> r.skipValue()
        }
    }
    r.endObject()
    return JsonObject(out)
}

/** An array of objects reduced to `keys`; `ops` only keeps its length. */
private fun readPicked(r: JsonReader, keys: Set<String>): JsonArray {
    val list = ArrayList<JsonElement>()
    r.beginArray()
    while (r.hasNext()) {
        if (r.peek() != JsonToken.BEGIN_OBJECT) {
            r.skipValue()
            continue
        }
        val m = LinkedHashMap<String, JsonElement>()
        r.beginObject()
        while (r.hasNext()) {
            val k = r.nextName()
            when {
                k !in keys -> r.skipValue()
                k == "ops" && r.peek() == JsonToken.BEGIN_ARRAY -> {
                    var n = 0
                    r.beginArray()
                    while (r.hasNext()) {
                        r.skipValue()
                        n++
                    }
                    r.endArray()
                    m[k] = JsonArray(List(n) { JsonNull })
                }
                else -> m[k] = readValue(r)
            }
        }
        r.endObject()
        list += JsonObject(m)
    }
    r.endArray()
    return JsonArray(list)
}

private fun readValue(r: JsonReader): JsonElement = when (r.peek()) {
    JsonToken.BEGIN_OBJECT -> {
        val m = LinkedHashMap<String, JsonElement>()
        r.beginObject()
        while (r.hasNext()) m[r.nextName()] = readValue(r)
        r.endObject()
        JsonObject(m)
    }
    JsonToken.BEGIN_ARRAY -> {
        val l = ArrayList<JsonElement>()
        r.beginArray()
        while (r.hasNext()) l += readValue(r)
        r.endArray()
        JsonArray(l)
    }
    JsonToken.STRING -> JsonPrimitive(r.nextString())
    JsonToken.NUMBER -> r.nextString().let { s -> s.toLongOrNull()?.let(::JsonPrimitive) ?: s.toDoubleOrNull()?.let(::JsonPrimitive) ?: JsonPrimitive(s) }
    JsonToken.BOOLEAN -> JsonPrimitive(r.nextBoolean())
    JsonToken.NULL -> {
        r.nextNull()
        JsonNull
    }
    else -> {
        r.skipValue()
        JsonNull
    }
}

/** A failure the GitHub endpoints report in an `error` field, with or without an error status. */
private fun JsonElement.orError(): JsonElement {
    this["error"].text?.let { throw HookedException(it) }
    return this
}

/** The link summary the Links card shows (`/api/gh`): state, title, author, review decision. Null when unknown. */
suspend fun HookedClient.ghSummary(url: String): JsonElement? =
    get("api/gh", mapOf("url" to url), 30_000)["data"]?.takeIf { it !is JsonNull }

/** A pull request or issue in full: checks, comments, timeline, files (GitHub or GitLab). */
suspend fun HookedClient.ghDetail(url: String): JsonElement = get("api/github/detail", mapOf("url" to url), 60_000).orError()

/** Per-file patches of a pull request, by path. */
suspend fun HookedClient.ghDiff(url: String): JsonObject =
    get("api/github/diff", mapOf("url" to url), 60_000).orError()["files"].obj ?: JsonObject(emptyMap())

suspend fun HookedClient.ghRun(url: String): GhRun = GhRun.of(get("api/github/run", mapOf("url" to url), 30_000).orError())

/** A finished job's log; null while the job runs (GitHub serves none before the end). */
suspend fun HookedClient.ghJobLog(jobUrl: String): String? =
    get("api/github/run/log", mapOf("url" to jobUrl), 90_000).orError()["log"].str

/** A sub-agent's own transcript. */
suspend fun HookedClient.agentTranscript(session: String, agent: String): List<Message> =
    get("api/agent", mapOf("session" to session, "agent" to agent), 30_000)["messages"].arr.mapIndexed { i, m -> Message.of(i, m) }

/** Raw bytes of a GET, for images. */
suspend fun HookedClient.bytes(path: String, query: Map<String, String>): ByteArray = withContext(Dispatchers.IO) {
    val c = URL(url(path, query)).openConnection() as HttpURLConnection
    try {
        c.connectTimeout = 10_000
        c.readTimeout = 30_000
        val code = c.responseCode
        if (code !in 200..299) throw HookedException("Server error ($code)")
        c.inputStream.use { it.readBytes() }
    } catch (e: IOException) {
        throw HookedException(e.message ?: "Connection failed")
    } finally {
        c.disconnect()
    }
}

fun HookedClient.screenshotUrl(session: String, path: String) = url("api/screenshot", mapOf("session" to session, "path" to path))

/**
 * The `data:` payloads of one server-sent event stream, without reconnecting: a background job's log
 * restarts with its seed on every connection, so a retry would repeat it.
 */
fun HookedClient.sseOnce(path: String, query: Map<String, String>): Flow<String> = channelFlow {
    val c = URL(url(path, query)).openConnection() as HttpURLConnection
    c.connectTimeout = 10_000
    c.readTimeout = 0
    c.setRequestProperty("Accept", "text/event-stream")
    val reader = launch(Dispatchers.IO) {
        try {
            c.inputStream.bufferedReader().use { r ->
                while (true) {
                    val line = r.readLine() ?: break
                    if (line.startsWith("data:")) send(line.substring(5).trim())
                }
            }
        } catch (_: IOException) {
        }
    }
    // Cancelling the collector lands here: disconnecting unblocks the read.
    try {
        reader.join()
    } finally {
        c.disconnect()
    }
}

/** A background job's output, as base64 chunks (`/api/background/stream`). */
fun HookedClient.jobLog(session: String, taskId: String) = sseOnce("api/background/stream", mapOf("id" to session, "taskId" to taskId))
