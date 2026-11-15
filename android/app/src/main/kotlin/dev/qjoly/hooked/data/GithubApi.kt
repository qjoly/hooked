package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonElement

// The endpoints behind the GitHub page.

/** `{ fetchedAt, review, mine, issues, notifications }`; `refresh` bypasses the server's short cache. */
suspend fun HookedClient.githubOverview(refresh: Boolean): JsonElement {
    val j = get("api/github", if (refresh) mapOf("refresh" to "1") else emptyMap(), 90_000)
    j["error"].text?.let { throw HookedException(it) }
    return j
}

/** The threads that went through, and the first GitHub error if some stayed. */
data class NotificationsDone(val done: List<String>, val error: String?)

/** Marks notification threads as done, like the inbox's "Done". */
suspend fun HookedClient.markNotificationsDone(ids: List<String>): NotificationsDone {
    val r = post("api/github/notifications", body("ids" to ids), 60_000)
    return NotificationsDone(r["done"].arr.mapNotNull { it.str }, r["error"].text)
}
