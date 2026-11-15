package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import java.util.Locale

// Pure helpers behind the Stats, Digest, Memory, Skills and Prompts pages (desktop-rune's view/pages.rs and fmt.rs).

/** The Stats range picker: server key and label. */
val STATS_RANGES = listOf("1" to "Today", "7" to "7 days", "30" to "30 days", "all" to "All")

private fun f0(x: Double) = String.format(Locale.ROOT, "%.0f", x)
private fun f1(x: Double) = String.format(Locale.ROOT, "%.1f", x)

/** "1.2B", "3.4M", "5.6k" or "123". */
fun tokens(n: Double): String = when {
    n >= 1e9 -> f1(n / 1e9) + "B"
    n >= 1e6 -> f1(n / 1e6) + "M"
    n >= 1e3 -> f1(n / 1e3) + "k"
    else -> f0(n)
}

fun count(n: Double?) = f0(n ?: 0.0)

/** rune's `fmt::span` with a separator between number and unit: "45 min", "3 h". */
fun spanSep(ms: Long, sep: String): String {
    val s = ms.coerceAtLeast(0) / 1000
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}${sep}min"
        s < 86_400 -> "${s / 3600}${sep}h"
        else -> "${s / 86_400}${sep}d"
    }
}

fun resetsLabel(minutes: Double?): String = minutes?.let { "resets in " + spanSep((it * 60_000).toLong(), " ") } ?: "—"

fun contextSizeLabel(n: Double?): String = when {
    n == null -> "—"
    n >= 1e6 -> "of ${f0(n / 1e6)}M tokens"
    else -> "of ${f0(n / 1e3)}k tokens"
}

fun pctLabel(p: Double?) = p?.let { f0(it) + "%" } ?: "—"

fun shortModel(m: String) = m.removePrefix("claude-")

/** An MCP tool shows by its own name, without the `mcp__server__` prefix. */
fun toolLabel(name: String) = name.substringAfterLast("__")

/** The first non-blank line, trimmed and cut to `max` characters with an ellipsis. */
fun firstLine(s: String, max: Int): String {
    val line = s.lines().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    return if (line.codePointCount(0, line.length) > max) line.take(line.offsetByCodePoints(0, max)) + "…" else line
}

/** `YYYY-MM-DD` moved by `delta` days; an out-of-month day rolls over as rune's civil arithmetic does. */
fun shiftDate(date: String, delta: Long): String? {
    if (date.length != 10 || date[4] != '-' || date[7] != '-') return null
    val y = date.substring(0, 4).toIntOrNull() ?: return null
    val m = date.substring(5, 7).toIntOrNull() ?: return null
    val d = date.substring(8, 10).toIntOrNull() ?: return null
    if (m !in 1..12 || d !in 1..31) return null
    return LocalDate.of(y, m, 1).plusDays(d - 1 + delta).toString()
}

/** One horizontal bar: label, value and its share of the largest. */
data class Bar(val label: String, val value: Double, val frac: Float)

/**
 * An object's entries ranked largest first, by `field` (or the value itself when null).
 * `floor` keeps a tiny maximum from blowing the fractions up, as rune's `.max(0.01)`.
 */
fun ranked(obj: JsonElement?, field: String?, take: Int = Int.MAX_VALUE, floor: Double = 0.01, label: (String) -> String = { it }): List<Bar> {
    val entries = obj.obj?.entries.orEmpty().map { (k, v) -> k to ((if (field == null) v else v[field]).dbl ?: 0.0) }
        .sortedByDescending { it.second }
    val max = (entries.firstOrNull()?.second ?: 1.0).coerceAtLeast(floor)
    return entries.take(take).map { (k, v) -> Bar(label(k), v, (v / max).toFloat().coerceIn(0f, 1f)) }
}

data class DayCost(val date: String, val cost: Double, val turns: Double)

/** The last `last` days of `byDay`, oldest first. */
fun costDays(byDay: JsonElement?, last: Int = 31): List<DayCost> =
    byDay.obj?.entries.orEmpty().sortedBy { it.key }.takeLast(last).map { (d, x) -> DayCost(d, x["cost"].dbl ?: 0.0, x["turns"].dbl ?: 0.0) }

fun dayLabel(date: String) = if (date.length > 5) date.substring(5) else date

data class Memory(val file: String, val name: String, val description: String?, val type: String, val body: String)

data class MemoryProject(val name: String, val cwd: String?, val memories: List<Memory>)

fun memoryProjects(v: JsonElement?): List<MemoryProject> = v["projects"].arr.map { p ->
    MemoryProject(
        p["name"].str.orEmpty(),
        p["cwd"].text,
        p["memories"].arr.map { m ->
            val file = m["file"].str.orEmpty()
            Memory(file, m["name"].str ?: file, m["description"].text, m["type"].str.orEmpty(), m["body"].str.orEmpty())
        },
    )
}

/** Keeps the memories of `type` (any when null) matching `query` in name, description or body; drops emptied projects. */
fun filterMemories(projects: List<MemoryProject>, type: String?, query: String): List<MemoryProject> {
    val q = query.trim().lowercase()
    fun keep(m: Memory) = (type == null || m.type == type) &&
        (q.isEmpty() || listOfNotNull(m.name, m.description, m.body).any { q in it.lowercase() })
    return projects.map { it.copy(memories = it.memories.filter(::keep)) }.filter { it.memories.isNotEmpty() }
}

/** Skills matching `query` in name or description, grouped by source in order of first appearance. */
fun skillGroups(list: List<JsonElement>, query: String): List<Pair<String, List<JsonElement>>> {
    val q = query.trim().lowercase()
    val groups = LinkedHashMap<String, MutableList<JsonElement>>()
    for (x in list) {
        if (q.isNotEmpty() && listOf("name", "description").none { x[it].str?.lowercase()?.contains(q) == true }) continue
        groups.getOrPut(x["source"].str ?: "other") { mutableListOf() } += x
    }
    return groups.map { it.key to it.value }
}

/** The frontmatter beyond name and description, as "key: value  ·  key: value". */
fun skillMeta(meta: JsonElement?): String = meta.obj?.entries.orEmpty()
    .filter { it.key != "name" && it.key != "description" }
    .joinToString("  ·  ") { (k, v) -> "$k: " + ((v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: v.toString()) }

fun bulletBlock(title: String, items: List<String>) = "**$title**\n\n" + items.joinToString("\n") { "- $it" }

data class SavedPrompt(val name: String, val text: String)

fun promptLibrary(settings: JsonElement?): List<SavedPrompt> =
    settings["promptLibrary"].arr.map { SavedPrompt(it["name"].str.orEmpty(), it["text"].str.orEmpty()) }

fun promptLibraryJson(list: List<SavedPrompt>) = JsonArray(list.map { JsonObject(mapOf("name" to JsonPrimitive(it.name), "text" to JsonPrimitive(it.text))) })

sealed interface LinkTarget {
    data class Session(val id: String) : LinkTarget
    data class Open(val url: String) : LinkTarget
}

/** rune's `link_target`: `/session/<id>` opens in the app, other server paths on the server, bare hosts over https. */
fun linkTarget(url: String, base: String): LinkTarget {
    val u = url.trim()
    if (u.startsWith("/session/")) {
        val id = u.removePrefix("/session/").split('?', '#', '/').first()
        if (id.isNotEmpty()) return LinkTarget.Session(id)
    }
    return LinkTarget.Open(
        when {
            "://" in u || u.startsWith("mailto:") -> u
            u.startsWith("/") -> base + u
            else -> "https://$u"
        },
    )
}
