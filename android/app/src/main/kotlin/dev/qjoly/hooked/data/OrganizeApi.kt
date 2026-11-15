package dev.qjoly.hooked.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// The account modal's and the query window's endpoints.

/** A POST whose error body matters (the Grafana query's `login` flag rides on a 401). */
suspend fun HookedClient.postRaw(path: String, payload: JsonObject, timeoutMs: Int = 60_000): Pair<Int, JsonElement> = withContext(Dispatchers.IO) {
    val c = URL(url(path)).openConnection() as HttpURLConnection
    try {
        c.requestMethod = "POST"
        c.connectTimeout = 10_000
        c.readTimeout = timeoutMs
        c.doOutput = true
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(payload.toString().toByteArray()) }
        val code = c.responseCode
        val raw = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
        code to runCatching { Json.parseToJsonElement(raw) }.getOrDefault(JsonNull)
    } catch (e: IOException) {
        throw HookedException(e.message ?: "Connection failed")
    } finally {
        c.disconnect()
    }
}

suspend fun HookedClient.account(): JsonElement = get("api/account")

/** `login` (mode), `login-status` / `login-input` (text) / `login-cancel` (id), or `logout`. */
suspend fun HookedClient.accountAction(action: String, vararg extra: Pair<String, Any?>): JsonElement =
    post("api/account", body("action" to action, *extra), 30_000)

/** A query Claude ran: `{ tool, input, data }`, data null for `show_query`. */
suspend fun HookedClient.queryResult(session: String, toolId: String): JsonElement =
    get("api/query-result", mapOf("session" to session, "agent" to "", "id" to toolId))

suspend fun HookedClient.grafanaQuery(spec: JsonObject) = postRaw("api/grafana/query", spec)

/** The mcp-gateway sign-in page; its callback lands on the server as this device reaches it. */
suspend fun HookedClient.grafanaLoginUrl(): String? {
    val proto = if (config.base.startsWith("https")) "https" else "http"
    return get("api/grafana/login", mapOf("proto" to proto))["url"].text
}

suspend fun HookedClient.grafanaConnected(): Boolean = get("api/grafana/status")["connected"].bool
