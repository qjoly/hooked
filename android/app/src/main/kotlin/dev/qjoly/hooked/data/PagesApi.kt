package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.net.URLEncoder

// The endpoints behind the Stats, Digest, Memory, Cron, Skills and Prompts pages.

suspend fun HookedClient.stats(range: String): JsonElement = get("api/stats", mapOf("range" to range), 60_000)

/** The raw `/api/usage`: account limits and the current session snapshot. */
suspend fun HookedClient.usageRaw(): JsonElement = get("api/usage")

/** `{ digests, latest, yesterday }`. */
suspend fun HookedClient.digestIndex(): JsonElement = get("api/digest")

suspend fun HookedClient.digest(date: String): JsonElement = get("api/digest", mapOf("date" to date))

/** Starts the AI summary for `date`; the server writes it in the background (status `running`). */
suspend fun HookedClient.generateDigest(date: String, force: Boolean): JsonElement =
    post("api/digest", body("date" to date, "force" to force), 120_000)

suspend fun HookedClient.memory(): JsonElement = get("api/memory", timeoutMs = 60_000)

suspend fun HookedClient.cronTasks(): List<JsonElement> = get("api/cron")["tasks"].arr

/** `{ op: save, task }`, `{ op: delete, id }` or `{ op: run, id }`. */
suspend fun HookedClient.cronOp(op: JsonObject): JsonElement = post("api/cron", op, 120_000)

private fun cwdQuery(cwds: List<String>) = cwds.joinToString("&") { "cwd=" + URLEncoder.encode(it, "UTF-8") }

/** Skills, plus those of each project in `cwds` (the server reads `cwd` repeated). */
suspend fun HookedClient.skills(cwds: List<String>): List<JsonElement> =
    get(if (cwds.isEmpty()) "api/skills" else "api/skills?" + cwdQuery(cwds), timeoutMs = 60_000).arr

suspend fun HookedClient.skill(id: String, cwds: List<String>): JsonElement {
    val q = "id=" + URLEncoder.encode(id, "UTF-8") + if (cwds.isEmpty()) "" else "&" + cwdQuery(cwds)
    return get("api/skills?$q")
}

/** Settings are a shallow merge server-side, so one key is sent whole. */
suspend fun HookedClient.saveSetting(key: String, value: JsonElement): JsonElement = post("api/settings", JsonObject(mapOf(key to value)))
