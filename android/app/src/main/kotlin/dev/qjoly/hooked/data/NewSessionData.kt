package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.absoluteValue
import kotlin.math.roundToLong

// Pure helpers behind rune's New session page (view/new_session.rs, app.rs).

/** What the project picker needs of a session. */
data class SeenProject(val project: String?, val worktreeOf: String?, val lastActivity: Long?)

/** A worktree folds into its main checkout when asked to: hooked's own through `worktreeOf`, the CLI's by path. */
fun pickerPath(project: String, worktreeOf: String?, collapse: Boolean): String {
    if (!collapse) return project
    worktreeOf?.let { return it }
    val i = project.indexOf("/.claude/worktrees/")
    return if (i >= 0) project.substring(0, i) else project
}

/** rune's `launch_projects`: favourites first (flagged true), then by last activity. */
fun launchProjects(favorites: List<String>, seen: List<SeenProject>, collapse: Boolean): List<Pair<String, Boolean>> {
    val out = favorites.map { it to true }.toMutableList()
    for (s in seen.sortedByDescending { it.lastActivity ?: 0L }) {
        val p = pickerPath(s.project ?: continue, s.worktreeOf, collapse)
        if (out.none { it.first == p }) out += p to false
    }
    return out
}

fun filterProjects(list: List<Pair<String, Boolean>>, query: String, max: Int = 14): List<Pair<String, Boolean>> {
    val q = query.trim().lowercase()
    return list.filter { q.isEmpty() || it.first.lowercase().contains(q) }.take(max)
}

/** rune's `folder_color` index into accent, info, success, warning, danger. */
fun folderHueIndex(path: String): Int {
    var h = 0
    for (ch in path) h = h * 31 + ch.code.toShort().toInt()
    return (h.toLong().absoluteValue % 5).toInt()
}

/** A saved prompt dropped into the draft: after a blank line, or alone. */
fun appendPrompt(current: String, text: String): String {
    val cur = current.trimEnd()
    return if (cur.isEmpty()) text else "$cur\n\n$text"
}

fun isFableModel(model: String?) = model != null && (model.startsWith("fable") || model.startsWith("claude-fable"))

/** The Fable bucket of `/api/usage` when it is spent: `pct` is the authority, `severity` the fallback. */
fun fableSpent(usage: JsonElement?): JsonElement? {
    val f = usage["account"]["fable"].obj ?: return null
    val pct = f["pct"].dbl
    val spent = if (pct != null) pct >= 100.0 else f["severity"].str.equals("exhausted", ignoreCase = true)
    return f.takeIf { spent }
}

/** A Fable default with its quota spent: the launch falls back to Opus. */
fun newFallback(defaultModel: String?, usage: JsonElement?) = isFableModel(defaultModel) && fableSpent(usage) != null

fun fableNotice(f: JsonElement?): String {
    val reset = f["resetInMin"].dbl?.let { m -> if (m >= 60) " (resets in ${(m / 60).roundToLong()}h)" else " (resets in ${m.roundToLong()}m)" }.orEmpty()
    return "${f["label"].str ?: "Fable"} weekly limit reached$reset. Defaulting to Opus so the session doesn't fail on its first turn."
}

/** The permission mode a launch starts on: hooked's setting, else Claude Code's own default. */
fun initialMode(settings: JsonElement?, claudeDefault: String?): String =
    settings["defaultMode"].text?.takeIf { it in LAUNCH_MODES }
        ?: claudeDefault?.takeIf { it in LAUNCH_MODES }
        ?: "default"

data class LaunchRequest(
    val cwd: String,
    val prompt: String,
    val model: String?,
    val effort: String?,
    val mode: String,
    val incognito: Boolean,
    val worktree: Boolean,
    val base: String = "",
    val branch: String = "",
    val ephemeral: Boolean,
) {
    fun json(): JsonObject = body(
        "cwd" to cwd,
        "prompt" to prompt,
        "model" to model,
        "effort" to effort,
        "permissionMode" to mode,
        "incognito" to incognito,
        "worktree" to if (worktree) body("base" to base.trim().ifEmpty { null }, "branch" to branch.trim().ifEmpty { null }) else JsonPrimitive(false),
        "ephemeral" to ephemeral,
    )
}
