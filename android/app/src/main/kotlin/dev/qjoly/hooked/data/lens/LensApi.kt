package dev.qjoly.hooked.data.lens

import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.obj
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The endpoints the Review, MCP and Trace lenses call, as desktop's api.rs and lenses.rs.

/** Claude's edits and the prompts they belong to, read from the session detail. */
suspend fun HookedClient.sessionChanges(id: String): Pair<List<Change>, List<ChangeTurn>> {
    return changesOf(get("api/session", mapOf("id" to id), 30_000))
}

/** The uncapped edit list of one file whose capped entry was truncated. */
suspend fun HookedClient.fullChange(id: String, path: String): Change? =
    get("api/session/file-changes", mapOf("id" to id, "path" to path), 60_000)["change"]?.obj?.let(Change::of)

/** Read from `repos`, not the top-level `changes`, which only mirror the primary repo. */
suspend fun HookedClient.vcsChanges(id: String): List<Repo> =
    get("api/session/vcs-diff", mapOf("id" to id), 60_000)["repos"].arr.map(Repo::of)

suspend fun HookedClient.vcsBaseDiff(id: String): BaseDiff =
    BaseDiff.of(get("api/session/vcs-base-diff", mapOf("id" to id), 60_000))

/** `root` picks one of the detected repos; none means the primary one. */
suspend fun HookedClient.vcsBranches(id: String, root: String?): JsonElement =
    get("api/session/vcs-branches", listOfNotNull("id" to id, root?.let { "root" to it }).toMap(), 30_000)

suspend fun HookedClient.vcsBranch(id: String, branch: String, base: String, root: String, range: Pair<String, String>?): JsonElement {
    val q = mutableMapOf("id" to id, "branch" to branch, "base" to base, "root" to root)
    range?.let { (from, to) -> q["from"] = from; q["to"] = to }
    return get("api/session/vcs-branch", q, 60_000)
}

suspend fun HookedClient.vcsBlame(id: String, file: String, rev: String): JsonElement =
    get("api/session/vcs-blame", mapOf("id" to id, "file" to file, "rev" to rev), 30_000)

suspend fun HookedClient.symbolLookup(id: String, symbol: String, file: String, rev: String): JsonElement =
    get("api/session/symbol", mapOf("id" to id, "symbol" to symbol, "file" to file, "rev" to rev), 30_000)

suspend fun HookedClient.sourceSlice(id: String, file: String, rev: String, from: Int, to: Int): JsonElement =
    get("api/session/source", mapOf("id" to id, "file" to file, "rev" to rev, "from" to "$from", "to" to "$to"), 30_000)

suspend fun HookedClient.reviewThreads(id: String): List<ReviewThread> =
    get("api/review", mapOf("id" to id))["threads"].arr.map(ReviewThread::of)

/** Every review write: comment, edit, reply, archive, delete, sent, start. */
suspend fun HookedClient.reviewOp(body: JsonObject): JsonElement = post("api/review", body)

/** `cached` answers at once with the last check (nothing when never checked); the live one health-checks every server. */
suspend fun HookedClient.mcpList(cwd: String, cached: Boolean): List<McpServer> {
    val q = if (cached) mapOf("cwd" to cwd, "cached" to "1") else mapOf("cwd" to cwd)
    return get("api/mcp", q, if (cached) 20_000 else 180_000)["servers"].arr.map(McpServer::of)
}

/** `get`, `logout`, `login-cancel`: each spawns the CLI, so the wait can be long. */
suspend fun HookedClient.mcpAction(body: JsonObject): JsonElement = post("api/mcp", body, 120_000)

suspend fun HookedClient.mcpLogin(body: JsonObject): McpLogin = McpLogin.of(mcpAction(body)["login"])

suspend fun HookedClient.trace(id: String): List<TraceTurn> =
    get("api/session/trace", mapOf("id" to id), 30_000)["turns"].arr.map(TraceTurn::of)

private val pretty = Json { prettyPrint = true }

/** One span's input and result, as text: strings as they are, anything else pretty-printed. */
suspend fun HookedClient.traceTool(id: String, tool: String): Pair<String, String> {
    val v = get("api/session/trace", mapOf("id" to id, "tool" to tool), 30_000)
    fun text(k: String) = when (val x = v[k]) {
        null, JsonNull -> ""
        is JsonPrimitive -> if (x.isString) x.content else x.toString()
        else -> pretty.encodeToString(JsonElement.serializer(), x)
    }
    return text("input") to text("result")
}


/** `changes` and `changeTurns` of a GET /api/session body. */
fun changesOf(j: kotlinx.serialization.json.JsonElement?): Pair<List<Change>, List<ChangeTurn>> =
    j["changes"].arr.map(Change::of) to j["changeTurns"].arr.map(ChangeTurn::of)
