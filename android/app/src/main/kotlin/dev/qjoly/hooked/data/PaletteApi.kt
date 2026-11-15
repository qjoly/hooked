package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonObject

// The endpoints the command palette calls.

/** Full-text search over every transcript. */
suspend fun HookedClient.searchTranscripts(q: String, limit: Int = 50): List<Cite> =
    parseCites(get("api/search", mapOf("q" to q, "limit" to limit.toString()), 30_000))

/** Drops the live-state caches and rebuilds the session list now. */
suspend fun HookedClient.resync() {
    post("api/resync", JsonObject(emptyMap()))
}

/** Opens the session's project in Ghostty, on the server's machine. */
suspend fun HookedClient.openGhostty(id: String) {
    post("api/open-ghostty", body("id" to id))
}
