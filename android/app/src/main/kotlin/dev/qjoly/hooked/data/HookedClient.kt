package dev.qjoly.hooked.data

import dev.qjoly.hooked.ServerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class HookedException(message: String) : Exception(message)

/** The hooked HTTP API, the same endpoints the web dashboard and the iOS app use. */
class HookedClient(val config: ServerConfig) {

    fun url(path: String, query: Map<String, String> = emptyMap()): String {
        val q = query.entries.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
        return "${config.base}/$path" + if (q.isEmpty()) "" else "?$q"
    }

    suspend fun get(path: String, query: Map<String, String> = emptyMap(), timeoutMs: Int = 20_000): JsonElement =
        withContext(Dispatchers.IO) { send("GET", url(path, query), null, timeoutMs) }

    suspend fun post(path: String, body: JsonObject, timeoutMs: Int = 30_000): JsonElement =
        withContext(Dispatchers.IO) { send("POST", url(path), body.toString(), timeoutMs) }

    private fun send(method: String, url: String, payload: String?, timeoutMs: Int): JsonElement {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 10_000
            c.readTimeout = timeoutMs
            c.setRequestProperty("Accept", "application/json")
            if (payload != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(payload.toByteArray()) }
            }
            val code = c.responseCode
            val raw = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            val j = runCatching { Json.parseToJsonElement(raw) }.getOrDefault(JsonNull)
            val msg = j["error"].str.orEmpty()
            when {
                code == 409 -> throw HookedException(msg.ifEmpty { "This session is not driven by hooked." })
                code !in 200..299 -> throw HookedException(msg.ifEmpty { "Server error ($code)" })
                (j["ok"] as? JsonPrimitive)?.booleanOrNull == false -> throw HookedException(msg.ifEmpty { "Server error" })
            }
            return j
        } catch (e: IOException) {
            throw HookedException(e.message ?: "Connection failed")
        } finally {
            c.disconnect()
        }
    }

    suspend fun sessions(): List<Session> = get("api/sessions")["sessions"].arr.map(Session::of).filter { it.id.isNotEmpty() }

    suspend fun detail(id: String) = SessionDetail.of(get("api/session", mapOf("id" to id), 30_000))

    suspend fun capabilities() = Capabilities.of(get("api/capabilities"))

    suspend fun usage() = usageGauges(get("api/usage"))

    suspend fun defaults(): Defaults {
        val j = get("api/defaults")
        return Defaults(j["model"].text, j["effort"].text, j["mode"].text)
    }

    suspend fun ping() {
        if (get("api/session-meta", timeoutMs = 5_000)["meta"] == null) throw HookedException("Not a hooked service")
    }

    suspend fun reply(id: String, text: String) {
        post("api/reply", body("id" to id, "text" to text))
    }

    /** One entry per question: picked option indices, plus free text. */
    data class Selection(val multi: Boolean, val indices: List<Int>, val other: String? = null)

    suspend fun answer(id: String, selections: List<Selection>, note: String? = null) {
        val sel = JsonArray(selections.map { body("multi" to it.multi, "indices" to it.indices.map(::JsonPrimitive), "other" to it.other) })
        post("api/reply", body("id" to id, "selections" to sel, "note" to note))
    }

    suspend fun plan(id: String, action: String, feedback: String? = null) {
        post("api/plan", body("id" to id, "action" to action, "feedback" to feedback))
    }

    suspend fun interrupt(id: String) {
        post("api/interrupt", body("id" to id))
    }

    suspend fun kill(id: String) {
        post("api/kill", body("id" to id))
    }

    suspend fun setMode(id: String, mode: String) {
        post("api/mode", body("id" to id, "mode" to mode))
    }

    /** The cache impact when the server holds the switch because the prompt cache is warm, else null. */
    suspend fun setModel(id: String, model: String?, effort: String?, force: Boolean): JsonObject? {
        val r = post("api/model", body("id" to id, "model" to model, "effort" to effort, "force" to force.takeIf { it }))
        return if (r["held"].bool) r["cacheImpact"].obj ?: JsonObject(emptyMap()) else null
    }

    suspend fun setAutoApprove(id: String, on: Boolean) {
        post("api/auto-approve", body("id" to id, "on" to on))
    }

    /** Hides the session's decision until `until`; null wakes it up. */
    suspend fun snooze(id: String, until: Long?) {
        post("api/session-meta", JsonObject(mapOf("id" to JsonPrimitive(id), "snoozeUntil" to (until?.let(::JsonPrimitive) ?: JsonNull))))
    }

    suspend fun archive(id: String) {
        post("api/session-meta", body("id" to id, "archived" to true))
    }

    /** Archived and snoozed flags per session id. */
    suspend fun sessionMeta(): Map<String, JsonObject> =
        get("api/session-meta")["meta"].obj?.mapNotNull { (k, v) -> v.obj?.let { k to it } }?.toMap().orEmpty()

    suspend fun launch(cwd: String, prompt: String, model: String?, effort: String?, mode: String?): String {
        val r = post("api/launch", body("cwd" to cwd, "prompt" to prompt, "model" to model, "effort" to effort, "permissionMode" to mode), 60_000)
        return r["sessionId"].text ?: throw HookedException("The server did not return a session id")
    }

    /** Re-runs `claude --resume` under hooked, like the web Resume button: no model (keeps the cache), same effort. */
    suspend fun resume(id: String, prompt: String, effort: String?) {
        val mode = runCatching { get("api/settings")["defaultMode"].text }.getOrNull()
        post("api/launch", body("resumeId" to id, "prompt" to prompt, "effort" to effort, "permissionMode" to (mode ?: "default")), 60_000)
    }

    suspend fun uploadImage(jpegBase64: String): String {
        val r = post("api/upload-image", body("dataUrl" to "data:image/jpeg;base64,$jpegBase64"), 60_000)
        return r["path"].text ?: throw HookedException("Upload returned no path")
    }
}
