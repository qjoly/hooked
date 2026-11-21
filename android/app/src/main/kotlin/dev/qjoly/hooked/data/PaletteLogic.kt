package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonElement

// The command palette's hit list (desktop `view/palette.rs::hits`), without the UI.

const val CITATIONS_SHOWN = 5
const val PALETTE_SESSIONS = 40

/** A full-text search hit: the session it comes from and the snippet, `<mark>`ed. */
data class Cite(val session: String, val snippet: String)

/** A session as the palette matches it: title, project label and last prompt in one string. */
data class PaletteSession(val id: String, val hay: String)

sealed interface PaletteHit {
    /** Index into the command list the hits were built from. */
    data class Command(val index: Int) : PaletteHit
    data class Session(val id: String) : PaletteHit
    data class Citation(val session: String, val snippet: String) : PaletteHit
    data class More(val n: Int) : PaletteHit
}

fun parseCites(j: JsonElement?): List<Cite> =
    j["results"].arr.map { Cite(it["sessionId"].str.orEmpty(), it["snippet"].str.orEmpty()) }

/** A query that goes to the transcript search: not empty, not a `>` command filter. */
fun paletteSearchable(raw: String): Boolean = raw.trim().let { it.isNotEmpty() && !it.startsWith('>') }

/** [cites] is null until the search for this exact query is back; [visible] (incognito) drops hidden sessions' hits. */
fun paletteHits(
    raw: String,
    commands: List<Pair<String, String>>,
    sessions: List<PaletteSession>,
    cites: List<Cite>?,
    allCites: Boolean,
    visible: Set<String>?,
): List<PaletteHit> {
    val trimmed = raw.trim()
    val onlyCommands = trimmed.startsWith('>')
    val words = trimmed.trimStart('>').trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    fun matches(label: String) = label.lowercase().let { l -> words.all { it in l } }
    val out = mutableListOf<PaletteHit>()
    if (onlyCommands) {
        commands.forEachIndexed { i, (label, section) -> if (matches("$label $section")) out += PaletteHit.Command(i) }
        return out
    }
    commands.forEachIndexed { i, (label, _) ->
        if (if (words.isEmpty()) label == "New session" else matches(label)) out += PaletteHit.Command(i)
    }
    out += sessions.asSequence().filter { words.isEmpty() || matches(it.hay) }.take(PALETTE_SESSIONS).map { PaletteHit.Session(it.id) }
    if (words.isNotEmpty() && cites != null) {
        val pool = cites.filter { visible == null || it.session in visible }
        val shown = if (allCites) pool.size else minOf(CITATIONS_SHOWN, pool.size)
        pool.take(shown).forEach { out += PaletteHit.Citation(it.session, it.snippet) }
        if (pool.size > shown) out += PaletteHit.More(pool.size - shown)
    }
    return out
}

/** A snippet on one line: marks dropped, whitespace collapsed, cut at 140. */
fun snippetLine(s: String): String =
    firstLine(s.replace("<mark>", "").replace("</mark>", "").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" "), 140)
