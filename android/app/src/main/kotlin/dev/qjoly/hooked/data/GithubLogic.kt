package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

// The GitHub page's lists (desktop-rune `pages.rs`), on the `/api/github` overview.

/** Key into the overview and tab label, in rune's order. */
val GITHUB_TABS = listOf(
    "review" to "Review requested",
    "mine" to "My pull requests",
    "reviews" to "Latest reviews",
    "issues" to "Assigned issues",
    "notifications" to "Notifications",
)

/** Reviews others left on my pull requests, newest first, as their own feed. */
fun ghReviews(v: JsonElement?): List<JsonElement> {
    val out = mutableListOf<JsonElement>()
    for (pr in v["mine"].arr) {
        for (rv in pr["reviews"].arr) {
            if (rv["author"] == pr["author"]) continue
            val o = rv.obj ?: continue
            out += JsonObject(
                o + mapOf(
                    "repo" to (pr["repo"] ?: JsonNull),
                    "title" to (pr["title"] ?: JsonNull),
                    "number" to (pr["number"] ?: JsonNull),
                    "url" to (pr["url"] ?: JsonNull),
                    "updatedAt" to (rv["at"] ?: JsonNull),
                ),
            )
        }
    }
    return out.sortedByDescending { it["at"].str }
}

/** A row's title: pull requests and issues carry `title`, notifications `subject` on older servers. */
fun ghTitle(x: JsonElement): String = x["title"].str ?: x["subject"].str ?: ""

/** The web's `ghFilter`: words with a `/` scope to repos by prefix, the rest must all match the title or repo. */
fun ghKeep(query: String, x: JsonElement): Boolean {
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val repo = x["repo"].str.orEmpty().lowercase()
    val title = ghTitle(x).lowercase()
    val (scopes, terms) = words.partition { '/' in it }
    return (scopes.isEmpty() || scopes.any { repo.startsWith(it) }) && terms.all { it in title || it in repo }
}

/** Every item of a tab, before filtering. */
fun ghAll(v: JsonElement?, key: String): List<JsonElement> = if (key == "reviews") ghReviews(v) else v[key].arr

/** A tab's items, narrowed to the picked repo and the filter words. */
fun ghItems(v: JsonElement?, key: String, query: String, repo: String?): List<JsonElement> =
    ghAll(v, key).filter { repo == null || it["repo"].str == repo }.filter { ghKeep(query, it) }

data class RepoCount(val repo: String, val count: Int, val latest: String)

/** Repos across every tab with their item count, most recently updated first. */
fun ghRepos(v: JsonElement?): List<RepoCount> {
    val by = LinkedHashMap<String, RepoCount>()
    for ((key, _) in GITHUB_TABS) {
        for (x in ghAll(v, key)) {
            val r = x["repo"].str?.takeIf { it.isNotEmpty() } ?: continue
            val at = x["updatedAt"].str.orEmpty()
            val cur = by[r]
            by[r] = if (cur == null) RepoCount(r, 1, at) else cur.copy(count = cur.count + 1, latest = maxOf(cur.latest, at))
        }
    }
    return by.values.sortedByDescending { it.latest }
}

/** The check dot's tone from a pull request's rolled-up `checks`: ok, ko, wait, or null for none. */
fun ghCheckTone(checks: String?): String? = when (checks) {
    "SUCCESS" -> "ok"
    "FAILURE", "ERROR" -> "ko"
    "PENDING" -> "wait"
    else -> null
}

/** The review decision, or a review's own state, as a label and a tone (ok, ko, muted, faint). */
fun ghRowDecision(x: JsonElement): Pair<String, String>? = when (x["decision"].str ?: x["state"].str) {
    "APPROVED" -> "Approved" to "ok"
    "CHANGES_REQUESTED" -> "Changes requested" to "ko"
    "COMMENTED" -> "Commented" to "muted"
    "DISMISSED" -> "Dismissed" to "faint"
    "REVIEW_REQUIRED" -> "Review required" to "faint"
    else -> null
}

/** "repo #12 · author · 3h", leaving out what the item lacks (notifications have no number or author). */
fun ghMetaLine(x: JsonElement, ago: String): String {
    val head = listOfNotNull(x["repo"].text, x["number"].int?.let { "#$it" }).joinToString(" ")
    return listOfNotNull(head.ifEmpty { null }, x["author"].text, ago).joinToString(" · ")
}

/** Pull requests and issues open in the side panel; anything else goes to the browser. */
fun ghPeekable(url: String) = "/pull/" in url || "/issues/" in url

/** The overview without the notification threads GitHub marked done. */
fun withoutNotifications(v: JsonElement?, done: Collection<String>): JsonElement? {
    val o = v.obj ?: return v
    val list = o["notifications"] as? JsonArray ?: return v
    return JsonObject(o + ("notifications" to JsonArray(list.filter { it["id"].str !in done })))
}
