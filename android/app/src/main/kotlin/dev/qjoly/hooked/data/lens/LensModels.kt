package dev.qjoly.hooked.data.lens

import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.obj
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// The payloads of the Review, MCP and Trace lenses, as desktop's api.rs decodes them.

/** One file Claude (or git) changed: an op per edit, plus the replayable raw ops. */
data class Change(
    val file: String,
    val name: String? = null,
    val badge: String? = null,
    val ops: List<JsonObject> = emptyList(),
    val rawOps: List<JsonObject> = emptyList(),
    val original: String? = null,
    val truncated: Boolean = false,
) {
    companion object {
        fun of(j: JsonElement?) = Change(
            file = j["file"].str.orEmpty(),
            name = j["name"].str,
            badge = j["badge"].str,
            ops = j["ops"].arr.mapNotNull { it.obj },
            rawOps = j["rawOps"].arr.mapNotNull { it.obj },
            original = j["original"].str,
            truncated = j["truncated"].bool,
        )
    }
}

/** A prompt of the session, with when it was sent: what splits Claude's edits by prompt. */
data class ChangeTurn(val turn: Int, val ts: String, val prompt: String) {
    companion object {
        fun of(j: JsonElement?) = ChangeTurn(j["turn"].int ?: 0, j["ts"].str.orEmpty(), j["prompt"].str.orEmpty())
    }
}

/** A git / jj repository under the session's directory. */
data class Repo(val root: String, val label: String, val primary: Boolean, val changes: List<Change> = emptyList()) {
    /** The server leaves the primary repo's label empty. */
    val name: String get() = label.ifEmpty { root.substringAfterLast('/') }

    companion object {
        fun of(j: JsonElement?) = Repo(j["root"].str.orEmpty(), j["label"].str.orEmpty(), j["primary"].bool, j["changes"].arr.map(Change::of))
    }
}

/** A worktree's changes since it forked from its base: commits and uncommitted edits. */
data class BaseDiff(
    val root: String? = null,
    val base: String? = null,
    val mergeBase: String? = null,
    val branch: String? = null,
    val commits: Int = 0,
    val changes: List<Change> = emptyList(),
    val truncated: Boolean = false,
) {
    companion object {
        fun of(j: JsonElement?) = BaseDiff(
            j["root"].text, j["base"].text, j["mergeBase"].text, j["branch"].text,
            j["commits"].int ?: 0, j["changes"].arr.map(Change::of), j["truncated"].bool,
        )
    }
}

data class ReviewMessage(val author: String, val text: String)

/** A review thread anchored on diff lines; `opIndex` is the diff section key it was left on. */
data class ReviewThread(
    val id: String,
    val file: String,
    val name: String,
    val opIndex: String,
    val side: String,
    val start: Int,
    val end: Int,
    val snippet: String,
    val status: String,
    val sent: Boolean,
    val messages: List<ReviewMessage>,
) {
    val archived get() = status == "archived"
    val old get() = side == "old"
    val text get() = messages.firstOrNull()?.text.orEmpty()

    companion object {
        fun of(j: JsonElement?) = ReviewThread(
            id = j["id"].str.orEmpty(),
            file = j["file"].str.orEmpty(),
            name = j["name"].str.orEmpty(),
            opIndex = j["opIndex"].str.orEmpty(),
            side = j["side"].str ?: "new",
            start = j["start"].int ?: 0,
            end = j["end"].int ?: 0,
            snippet = j["snippet"].str.orEmpty(),
            status = j["status"].str ?: "open",
            sent = j["sent"].bool,
            messages = j["messages"].arr.map { ReviewMessage(it["author"].str ?: "user", it["text"].str.orEmpty()) },
        )
    }
}

data class McpServer(
    val name: String,
    val target: String?,
    val transport: String?,
    val state: String,
    val status: String?,
    val scopeLabel: String?,
    val authable: Boolean,
) {
    companion object {
        fun of(j: JsonElement?) = McpServer(
            j["name"].str.orEmpty(), j["target"].str, j["transport"].str, j["state"].str.orEmpty(),
            j["status"].text, j["scopeLabel"].str, j["authable"].bool,
        )
    }
}

/** A `claude mcp login` in flight on the server, as its PTY last left it. */
data class McpLogin(
    val id: String? = null,
    val name: String = "",
    val url: String? = null,
    val done: Boolean = false,
    val exitCode: Int? = null,
    val needsPaste: Boolean = false,
    val outOfBand: Boolean = false,
    val output: String = "",
) {
    companion object {
        fun of(j: JsonElement?) = McpLogin(
            j["id"].text, j["name"].str.orEmpty(), j["url"].text, j["done"].bool, j["exitCode"].int,
            j["needsPaste"].bool, j["outOfBand"].bool, j["output"].str.orEmpty(),
        )
    }
}

/** One tool call, timed from the line that issued it to the line carrying its result. */
data class TraceSpan(val id: String, val name: String, val detail: String?, val start: Double, val end: Double?, val error: Boolean) {
    companion object {
        fun of(j: JsonElement?) = TraceSpan(j["id"].str.orEmpty(), j["name"].str.orEmpty(), j["detail"].text, j["start"].dbl ?: 0.0, j["end"].dbl, j["error"].bool)
    }
}

data class TraceTurn(val prompt: String?, val start: Double, val end: Double?, val spans: List<TraceSpan>) {
    companion object {
        fun of(j: JsonElement?) = TraceTurn(j["prompt"].str, j["start"].dbl ?: 0.0, j["end"].dbl, j["spans"].arr.map(TraceSpan::of))
    }
}
