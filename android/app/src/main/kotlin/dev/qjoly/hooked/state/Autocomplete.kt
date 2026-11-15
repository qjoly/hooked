package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.str
import kotlinx.serialization.json.JsonElement

// The composer's `/` command and `@` file completion (app.rs `ac_query` / `ac_items` / `ac_accept`).

sealed interface AcQuery {
    data class Command(val q: String) : AcQuery
    data class File(val q: String, val at: Int) : AcQuery
}

data class AcItem(val insert: String, val label: String, val sub: String, val badge: String)

/** What the text before the caret asks to complete, if anything. */
fun acQuery(before: String): AcQuery? {
    if (before.startsWith('/')) {
        val q = before.substring(1)
        if (q.all { it.isLetterOrDigit() && it.code < 128 || it == ':' || it == '_' || it == '-' }) return AcQuery.Command(q)
    }
    val at = before.lastIndexOf('@')
    if (at < 0) return null
    val q = before.substring(at + 1)
    val boundary = at == 0 || before[at - 1].isWhitespace()
    return if (boundary && q.none(Char::isWhitespace)) AcQuery.File(q, at) else null
}

fun acItems(v: JsonElement?, files: Boolean): List<AcItem> =
    if (files) {
        v["files"].arr.mapNotNull { it.str }.take(30).map { f -> AcItem("@$f ", f.substringAfterLast('/'), f, "") }
    } else {
        v["commands"].arr.map { c ->
            val name = c["name"].str.orEmpty()
            AcItem(
                insert = "/$name ",
                label = "/$name",
                sub = c["description"].str.orEmpty(),
                badge = if (c["group"].str == "custom") c["source"].str ?: "custom" else "built-in",
            )
        }
    }

/** The text with `item` replacing `start..caret`, and the caret after it. */
fun acApply(text: String, start: Int, caret: Int, item: AcItem): Pair<String, Int>? {
    if (caret > text.length || start > caret) return null
    return text.substring(0, start) + item.insert + text.substring(caret) to start + item.insert.length
}
