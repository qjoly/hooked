package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// The endpoints behind the Settings and New session pages, as rune calls them.

/** `{ installed, install: { label, upgrade }, outdated }`. */
suspend fun HookedClient.claudeInfo(): JsonElement = get("api/claude", timeoutMs = 30_000)

/** `{ current, ahead, behind, branches: [{ name, current, remote, locked }] }`. */
suspend fun HookedClient.gitInfo(): JsonElement = get("api/git", timeoutMs = 30_000)

/** The 5-hour window scheduler: `{ decision: { act, reason }, fiveHour: { at, pct } }`. */
suspend fun HookedClient.warmupInfo(): JsonElement = get("api/warmup")

/** `{ projects: [{ cwd, status }] }`. */
suspend fun HookedClient.remoteControl(): JsonElement = get("api/remote-control")

suspend fun HookedClient.runWarmup(): JsonElement = post("api/warmup", JsonObject(emptyMap()), 120_000)

/** `strategy`: block (fails on a dirty tree), stash or force. */
suspend fun HookedClient.checkoutBranch(branch: String, strategy: String): JsonElement =
    post("api/git", body("action" to "checkout", "branch" to branch, "strategy" to strategy), 120_000)

/** `{ removed, kept, failed }`. */
suspend fun HookedClient.cleanupWorktrees(): JsonElement = post("api/worktrees", body("action" to "cleanup"), 300_000)

/** `{ checkouts: [{ path, branch, result, commits, why }] }`. */
suspend fun HookedClient.pullCheckouts(): JsonElement = post("api/worktrees", body("action" to "pull"), 300_000)

suspend fun HookedClient.resyncStates(): JsonElement = post("api/resync", JsonObject(emptyMap()), 60_000)

suspend fun HookedClient.upgradeClaude(): JsonElement = post("api/claude", body("action" to "upgrade"), 600_000)

suspend fun HookedClient.tagMap(): Map<String, List<String>> = get("api/tags")["tags"]?.tagsJson().orEmpty()

/** Replaces every session's tags at once. */
suspend fun HookedClient.replaceTags(tags: Map<String, List<String>>): JsonElement = post("api/tags", body("replace" to tagsBody(tags)))

/** `{ root, defaultBase, branches }`, or an error for a folder outside git. */
suspend fun HookedClient.worktreeBases(cwd: String): JsonElement = get("api/worktrees/bases", mapOf("cwd" to cwd), 30_000)

/** Launches a driven session and returns its id. */
suspend fun HookedClient.launchSession(req: LaunchRequest): String {
    val r = post("api/launch", req.json(), 120_000)
    return r["sessionId"].text ?: throw HookedException("The server returned no session id")
}
