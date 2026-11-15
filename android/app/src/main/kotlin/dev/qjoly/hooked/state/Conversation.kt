package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.obj
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The conversation as rune's api.rs reads it: what the shared models leave out (fork points,
// raw timestamps, the diff / send / show payloads tool parts carry) plus fmt.rs helpers.

private val pretty = Json { prettyPrint = true }

data class ToolCall(
    val id: String?,
    val name: String,
    val detail: String?,
    val inputText: String?,
    val result: String?,
    val diff: JsonObject? = null,
    val send: JsonObject? = null,
    val show: JsonObject? = null,
) {
    companion object {
        fun of(j: JsonElement?, part: JsonElement? = null): ToolCall {
            val r = j["result"]
            val diff = part["diff"].obj?.takeIf { it["ops"].arr.isNotEmpty() }
            return ToolCall(
                id = j["id"].text,
                name = j["name"].str ?: "tool",
                detail = j["detail"].text,
                inputText = j["inputText"].text,
                result = when (r) {
                    null, is JsonNull -> null
                    is JsonPrimitive -> r.content
                    else -> pretty.encodeToString(JsonElement.serializer(), r)
                },
                diff = diff,
                send = part["send"].obj,
                show = part["show"].obj,
            )
        }
    }
}

sealed interface TurnPart {
    data class Text(val text: String) : TurnPart
    data class Call(val tool: ToolCall) : TurnPart
}

/** One bubble of the transcript. */
data class Turn(
    val index: Int,
    val role: String,
    val tsRaw: String?,
    val ts: Long?,
    val text: String,
    val truncated: Boolean,
    val auto: Boolean,
    val kind: String?,
    val forkUuid: String?,
    val parts: List<TurnPart>,
) {
    val user get() = role == "user"

    companion object {
        fun of(index: Int, j: JsonElement?): Turn {
            val text = j["text"].str.orEmpty()
            val raw = j["parts"].arr.mapNotNull { p ->
                when (p["type"].str) {
                    "text" -> p["text"].str?.takeIf { it.isNotBlank() }?.let(TurnPart::Text)
                    "tool" -> p["tool"].obj?.let { TurnPart.Call(ToolCall.of(it, p)) }
                    else -> null
                }
            }
            val parts = raw.ifEmpty {
                (if (text.isBlank()) emptyList() else listOf(TurnPart.Text(text))) + j["tools"].arr.map { TurnPart.Call(ToolCall.of(it)) }
            }
            return Turn(
                index = index,
                role = j["role"].str ?: "system",
                tsRaw = j["ts"].str,
                ts = j["ts"].millis,
                text = text,
                truncated = j["truncated"].bool,
                auto = j["auto"].bool,
                kind = j["kind"].text,
                forkUuid = j["forkUuid"].text,
                parts = parts,
            )
        }
    }
}

/** The fields of /api/session the conversation view reads beyond `SessionDetail`. */
data class Conversation(
    val id: String,
    val title: String?,
    val project: String?,
    val model: String?,
    val cost: Double?,
    val turns: List<Turn>,
    val contextPct: Double?,
    val changes: Int,
    val startTs: String?,
    val lastTs: String?,
    val costBreak: JsonObject?,
    val usage: JsonObject?,
    val subagentCost: Double?,
    val followup: String?,
) {
    companion object {
        fun of(j: JsonElement?) = Conversation(
            id = j["id"].str.orEmpty(),
            title = j["title"].text,
            project = j["project"].text,
            model = j["model"].text,
            cost = j["cost"].dbl,
            turns = j["messages"].arr.mapIndexed(Turn::of),
            contextPct = j["context"]["pct"].dbl,
            changes = j["changes"].arr.size,
            startTs = j["startTs"].text,
            lastTs = j["lastTs"].text,
            costBreak = j["costBreak"].obj,
            usage = j["usage"].obj,
            subagentCost = j["subagentCost"].dbl,
            followup = j["followupSuggestion"].text,
        )
    }
}

private val IMAGE_EXTS = listOf(".png", ".jpg", ".jpeg", ".gif", ".webp")

private fun isImageName(p: String) = p.lowercase().let { l -> IMAGE_EXTS.any(l::endsWith) }

/** Pasted images reach the transcript as absolute paths under hooked's images dir: split them out. */
fun splitMessageImages(text: String): Pair<List<String>, String> {
    val images = mutableListOf<String>()
    val rest = StringBuilder()
    Regex("""\S+|\s+""").findAll(text).forEach { m ->
        val w = m.value
        if (w.startsWith('/') && "/images/" in w && isImageName(w)) images += w else rest.append(w)
    }
    return images to rest.toString().trim()
}

/** Pictures a tool call carries: SendUserFile images, then show_image's before and after. */
fun toolMedia(t: ToolCall): List<String> {
    val out = mutableListOf<String>()
    t.send?.get("files").arr.forEach { f -> if (f["kind"].str == "image") f["path"].text?.let(out::add) }
    t.show?.takeIf { it["kind"].str == "image" }?.let { s -> listOf("compare", "path").forEach { k -> s[k].text?.let(out::add) } }
    return out
}

fun firstLine(s: String, max: Int): String {
    val line = s.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    return if (line.codePointCount(0, line.length) > max) line.take(max) + "…" else line
}

/** The first `max` lines, and how many were left out. */
fun clipLines(s: String, max: Int): String {
    val lines = s.lines()
    if (lines.size <= max) return s
    return lines.take(max).joinToString("\n") + "\n… ${lines.size - max} more lines"
}

/** Lines an Edit / Write diff touches, to fold the big ones. */
fun diffLineCount(diff: JsonObject): Int {
    fun n(v: JsonElement?) = v.str?.let { s -> s.lines().size.coerceAtLeast(1) } ?: 0
    return diff["ops"].arr.sumOf { o -> maxOf(n(o["old"]), n(o["new"]), n(o["content"])) }
}

const val BIG_DIFF = 12

/** rune's `fmt::short_model`: the id without its "claude-" prefix. */
fun shortModelId(m: String) = m.removePrefix("claude-")

fun modeLabel(m: String?) = when (m) {
    "acceptEdits" -> "Accept edits"
    "auto" -> "Auto"
    "plan" -> "Plan"
    "bypassPermissions" -> "Bypass"
    "dontAsk" -> "Don't ask"
    else -> "Normal"
}

val LIVE_MODES = listOf("default", "auto", "plan")
val LAUNCH_MODES = listOf("default", "acceptEdits", "auto", "plan", "bypassPermissions")

/** rune's `fmt::span` with a separator: "42 min", "3 h". */
fun spanSep(ms: Long, sep: String = " "): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}${sep}min"
        s < 86_400 -> "${s / 3600}${sep}h"
        else -> "${s / 86_400}${sep}d"
    }
}

/** The working line's clock: "12s", then "3m4s". */
fun elapsedLabel(sec: Long) = if (sec < 60) "${sec}s" else "${sec / 60}m${sec % 60}s"

fun tokensLabel(n: Double) = when {
    n >= 1e6 -> String.format(java.util.Locale.ROOT, "%.1fM", n / 1e6)
    n >= 1e3 -> String.format(java.util.Locale.ROOT, "%.0fk", n / 1e3)
    else -> String.format(java.util.Locale.ROOT, "%.0f", n)
}

/** The plan comments sent with "Keep planning": each quote in `>` lines, then its note. */
fun composePlanFeedback(comments: List<Pair<String, String>>): String =
    "Feedback on the plan — please keep planning and revise:\n\n" +
        comments.joinToString("\n\n") { (quote, note) -> quote.lines().joinToString("\n") { "> $it" } + "\n" + note }

/** Model picker entries: (id, label) minus the ones hidden in Settings, labels prefixed by their family. */
fun visibleModels(caps: dev.qjoly.hooked.data.Capabilities, hidden: Set<String>): List<Pair<String, String>> =
    caps.models.flatMap { g ->
        g.options.map { o ->
            val label = if (o.label.lowercase().startsWith(g.label.lowercase())) o.label else "${g.label} ${o.label}"
            o.id to label.trim()
        }
    }.filter { it.first !in hidden }

/** Members of a group in order: the lead, then its children by join time. */
fun groupMembers(mother: String, sessions: List<dev.qjoly.hooked.data.Session>, meta: Map<String, dev.qjoly.hooked.data.Meta>): List<String> {
    val kids = sessions.filter { meta.of(it.id).groupOf == mother && it.id != mother }
        .sortedBy { meta.of(it.id).groupAt ?: Long.MAX_VALUE }
        .map { it.id }
    return listOf(mother) + kids
}
