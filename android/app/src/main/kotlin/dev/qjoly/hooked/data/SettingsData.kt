package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Pure helpers behind rune's Settings page (view/settings.rs, pages.rs).

val NAV_PAGES = listOf(
    "sessions" to "Sessions", "stats" to "Stats", "digest" to "Digest", "memory" to "Memory",
    "github" to "GitHub", "skills" to "Skills", "cron" to "Cron", "prompts" to "Prompts",
)

val EDITORS = listOf(
    "vscode" to "VS Code", "zed" to "Zed", "cursor" to "Cursor",
    "windsurf" to "Windsurf", "sublime" to "Sublime Text", "jetbrains" to "JetBrains",
)

val WEEK_DAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

data class FeatureFlag(val key: String, val title: String, val hint: String)

val FEATURE_FLAGS = listOf(
    FeatureFlag(
        "dockActions",
        "Session actions in the context panel",
        "Group, tags, pin, incognito, snooze and archive as large buttons at the bottom of the context panel, which then shows even when the session has nothing else in it.",
    ),
    FeatureFlag(
        "showPanels",
        "Interactive panels",
        "Claude gets the show_panel tool and draws small sandboxed Luau panels in a window here. Applies from the next launch or resume.",
    ),
)

val SESSION_MENU = listOf("modelEffort" to "Model and effort", "permissionMode" to "Permission mode")

val IDLE_DAYS = listOf(0, 3, 7, 14, 30, 90)

/** The tag palette's size, as rune's `TAG_HUE_COUNT`. */
const val TAG_HUE_COUNT = 11

val COMPACT_SIZES = listOf(0, 50, 100, 200, 400)

/** The modes a launch accepts, in rune's order (`fmt::LAUNCH_MODES`). */
val LAUNCH_MODES = listOf("default", "acceptEdits", "auto", "plan", "bypassPermissions")

fun strList(v: JsonElement?): List<String> = v.arr.mapNotNull { it.str }

/** A boolean setting; missing or null reads as the server's default. */
fun JsonElement?.boolOr(default: Boolean): Boolean = if (this is JsonPrimitive && this !is JsonNull) bool else default

/** The whole nested object `key` with `field` replaced: settings are a shallow merge server-side. */
fun withNested(settings: JsonElement?, key: String, field: String, value: JsonElement): JsonObject =
    JsonObject(settings[key].obj.orEmpty() + (field to value))

fun toggled(list: List<String>, item: String): List<String> = if (item in list) list - item else list + item

fun jsonStrings(list: List<String>) = JsonArray(list.map(::JsonPrimitive))

/** `[["09:00","12:00"], …]` as "09:00-12:00, 14:00-18:00". */
fun workHoursText(settings: JsonElement?): String =
    settings["warmup"]["workHours"].arr.mapNotNull { p ->
        val a = p.arr.getOrNull(0).str ?: return@mapNotNull null
        val b = p.arr.getOrNull(1).str ?: return@mapNotNull null
        "$a-$b"
    }.joinToString(", ")

/** The slots typed in Settings, or null when none reads as HH:MM-HH:MM. */
fun parseWorkHours(text: String): JsonArray? {
    fun ok(t: String) = t.length == 5 && t[2] == ':' && t.split(':').all { it.toIntOrNull()?.let { n -> n in 0..255 } == true }
    val slots = text.split(',').mapNotNull { slot ->
        val parts = slot.trim().split('-', limit = 2)
        if (parts.size != 2) return@mapNotNull null
        val (a, b) = parts.map(String::trim)
        if (ok(a) && ok(b)) JsonArray(listOf(JsonPrimitive(a), JsonPrimitive(b))) else null
    }
    return slots.takeIf { it.isNotEmpty() }?.let(::JsonArray)
}

fun toggledDay(days: List<Int>, day: Int): List<Int> = if (day in days) days - day else (days + day).sorted()

/** rune's hint under "5-hour window", with the scheduler's current decision when the server gave one. */
fun warmupHint(w: JsonElement?): String {
    val base = "Keep a usage window open across your working hours with a tiny early ping."
    val d = w["decision"].obj ?: return base
    val now = if (d["act"].bool) "ping due" else d["reason"].str.orEmpty()
    val window = w["fiveHour"]["at"].str?.let { at -> " · window open until $at (${num(w["fiveHour"]["pct"].dbl ?: 0.0)}% used)" }.orEmpty()
    return "$base Scheduler right now: $now$window."
}

private fun num(d: Double) = if (d == Math.floor(d)) d.toLong().toString() else d.toString()

/** A server path with the home folder shortened to `~`; the tablet does not know the server's HOME. */
fun tilde(path: String): String {
    val m = Regex("^/(Users|home)/[^/]+").find(path) ?: return path
    return "~" + path.substring(m.range.last + 1)
}

private fun plural(n: Int, word: String) = "$n $word" + if (n == 1) "" else "s"

/** "Removed / Kept / Failed" lines of a worktree clean-up; the flag marks a warning. */
fun cleanupReport(r: JsonElement?): List<Pair<String, Boolean>> {
    fun name(x: JsonElement) = tilde(x["path"].str.orEmpty()) + x["branch"].str?.let { " ($it)" }.orEmpty()
    val lines = mutableListOf<Pair<String, Boolean>>()
    for (x in r["removed"].arr) {
        val gone = if (x["branchDeleted"].bool) ", branch deleted" else ""
        lines += "Removed ${name(x)} · ${x["reason"].str.orEmpty()}$gone" to false
    }
    for (x in r["kept"].arr) lines += "Kept ${name(x)} · ${x["why"].str.orEmpty()}" to true
    for (x in r["failed"].arr) lines += "Failed ${name(x)} · ${x["error"].str.orEmpty()}" to true
    if (lines.isEmpty()) lines += "Nothing to clean up." to false
    return lines
}

/** One line per pulled, failed or skipped checkout, then the count of those already up to date. */
fun pullReport(r: JsonElement?): List<Pair<String, Boolean>> {
    val all = r["checkouts"].arr
    val lines = mutableListOf<Pair<String, Boolean>>()
    var fresh = 0
    for (c in all) {
        val at = tilde(c["path"].str.orEmpty()) + c["branch"].str?.let { " ($it)" }.orEmpty()
        when (c["result"].str.orEmpty()) {
            "pulled" -> lines += "Pulled ${plural(c["commits"].int ?: 0, "commit")} into $at" to false
            "up to date" -> fresh++
            "failed" -> lines += "Failed $at · ${c["why"].str.orEmpty()}" to true
            else -> lines += "Skipped $at · ${c["why"].str.orEmpty()}" to false
        }
    }
    if (fresh > 0 || all.isEmpty()) lines += "${plural(fresh, "checkout")} up to date." to false
    return lines
}

/** Renames (or, with a null `new`, deletes) a tag across every session; sessions left bare drop out. */
fun retag(tags: Map<String, List<String>>, old: String, new: String?): Map<String, List<String>> =
    tags.mapValues { (_, list) ->
        val i = list.indexOf(old)
        if (i < 0) {
            list
        } else {
            val next = list.toMutableList().apply { removeAt(i) }
            if (new != null && new !in next) next.add(i, new)
            next
        }
    }.filterValues { it.isNotEmpty() }

/** A typed tag name as hooked stores it: no leading `#`, lower case. */
fun cleanTag(raw: String) = raw.trim().trimStart('#').lowercase()

/** Sessions per tag, by name; `only` limits the count to those sessions (incognito). */
fun tagCounts(tags: Map<String, List<String>>, only: Set<String>? = null): List<Pair<String, Int>> {
    val counts = sortedMapOf<String, Int>()
    for ((id, list) in tags) {
        if (only != null && id !in only) continue
        for (t in list) counts[t] = (counts[t] ?: 0) + 1
    }
    return counts.map { it.key to it.value }
}

fun JsonElement.tagsJson(): Map<String, List<String>> = obj?.mapValues { (_, v) -> strList(v) }.orEmpty()

fun tagsBody(tags: Map<String, List<String>>) = JsonObject(tags.mapValues { jsonStrings(it.value) })

/** Remote control's candidates: favourites, then known projects, then any already on; 16 at most. */
fun remoteProjects(settings: JsonElement?, projects: List<String>): List<String> {
    val on = strList(settings["remoteControlProjects"])
    return (strList(settings["favoriteProjects"]) + projects + on).distinct().take(16)
}

fun rcStatus(rc: JsonElement?, cwd: String): String =
    rc["projects"].arr.firstOrNull { it["cwd"].str == cwd }?.let { it["status"].str ?: it["state"].str }.orEmpty()

/** The picker models: each option labelled with its family unless it already starts with it. */
fun flatModels(caps: Capabilities): List<ModelOption> = caps.models.flatMap { g ->
    g.options.map { o ->
        val label = if (o.label.lowercase().startsWith(g.label.lowercase())) o.label else "${g.label} ${o.label}"
        ModelOption(o.id, label.trim())
    }
}

/** The models the pickers offer: the installed claude's list minus the ones hidden in Settings. */
fun visibleModels(caps: Capabilities, settings: JsonElement?): List<ModelOption> {
    val hidden = strList(settings["hiddenModels"]).toSet()
    return flatModels(caps).filter { it.id !in hidden }
}

fun windowLabel(min: Int) = if (min == 0) "always" else "$min min"

fun hourLabel(h: Int) = h.toString().padStart(2, '0') + ":00"

/** The branches a checkout can switch to: unlocked ones, remote ones marked with ↓, 40 at most. */
data class BranchChip(val name: String, val label: String, val current: Boolean)

fun branchChips(git: JsonElement?): List<BranchChip> = git["branches"].arr
    .filter { !it["locked"].bool }
    .take(40)
    .map { b ->
        val name = b["name"].str.orEmpty()
        val current = b["current"].bool
        BranchChip(name, if (b["remote"].bool && !current) "$name ↓" else name, current)
    }
