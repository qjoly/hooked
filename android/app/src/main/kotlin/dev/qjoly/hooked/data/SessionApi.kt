package dev.qjoly.hooked.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// The session view's calls beyond the shared client, as rune's api.rs makes them.

suspend fun HookedClient.sessionRaw(id: String): JsonElement = get("api/session", mapOf("id" to id), 30_000)

/** Forks at a transcript line; an empty prompt opens the branch waiting for you. Returns the new session id. */
suspend fun HookedClient.fork(id: String, forkUuid: String, prompt: String, model: String?, effort: String?, mode: String?): String {
    val r = post("api/fork", body("id" to id, "forkUuid" to forkUuid, "prompt" to prompt, "model" to model, "effort" to effort, "permissionMode" to mode), 60_000)
    return r["sessionId"].text ?: throw HookedException("The fork returned no session id")
}

/** Stops the process and resumes it from its transcript. */
suspend fun HookedClient.restart(id: String) {
    post("api/claude", body("action" to "restart", "id" to id), 60_000)
}

/** Moves the transcript to the trash; it can be restored. */
suspend fun HookedClient.trash(id: String) {
    post("api/delete", body("id" to id))
}

suspend fun HookedClient.openEditor(id: String) {
    post("api/open-editor", body("id" to id))
}

suspend fun HookedClient.projectFiles(id: String, q: String): JsonElement = get("api/files", mapOf("id" to id, "q" to q))

suspend fun HookedClient.slashCommands(id: String, q: String): JsonElement = get("api/commands", mapOf("id" to id, "q" to q))

/** The whole text of a user message the transcript view cut. */
suspend fun HookedClient.fullMessage(id: String, uuid: String): String? = get("api/session/message", mapOf("id" to id, "uuid" to uuid))["text"].str

/** A new session joined to `mother`'s group. Returns its id. */
suspend fun HookedClient.launchInGroup(cwd: String, prompt: String, mother: String, model: String?, effort: String?, mode: String?): String {
    val r = post(
        "api/launch",
        body("cwd" to cwd, "prompt" to prompt, "model" to model, "effort" to effort, "permissionMode" to (mode ?: "default"), "groupWith" to mother),
        60_000,
    )
    return r["sessionId"].text ?: throw HookedException("The server returned no session id")
}

/** Raw bytes of a GET, for pictures. */
suspend fun HookedClient.bytes(path: String, query: Map<String, String>): ByteArray = withContext(Dispatchers.IO) {
    val c = URL(url(path, query)).openConnection() as HttpURLConnection
    try {
        c.connectTimeout = 10_000
        c.readTimeout = 30_000
        if (c.responseCode !in 200..299) throw HookedException("Server error (${c.responseCode})")
        c.inputStream.use { it.readBytes() }
    } catch (e: IOException) {
        throw HookedException(e.message ?: "Connection failed")
    } finally {
        c.disconnect()
    }
}

/** Where a picture of the conversation is served: pasted images, or files a tool call delivered. */
fun mediaQuery(session: String, path: String, pasted: Boolean): Pair<String, Map<String, String>> =
    if (pasted) "api/image" to mapOf("path" to path)
    else "api/user-file" to mapOf("session" to session, "agent" to "", "path" to path)
