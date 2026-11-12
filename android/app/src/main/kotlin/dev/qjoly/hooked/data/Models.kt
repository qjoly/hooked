package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

enum class SessionState(val label: String) {
    ATTENTION("Attention"), WAITING("Waiting"), WORKING("Working"), BACKGROUND("Background"),
    IDLE("Idle"), ENDED("Ended"), PAST("Past"), UNKNOWN("Idle");

    companion object {
        fun of(raw: String?) = entries.firstOrNull { it.name.equals(raw, ignoreCase = true) } ?: UNKNOWN
    }
}

data class QuestionOption(val label: String, val description: String?)

data class Question(val question: String, val header: String?, val multiSelect: Boolean, val options: List<QuestionOption>) {
    companion object {
        fun of(j: JsonElement?) = Question(
            question = j["question"].str.orEmpty(),
            header = j["header"].text,
            multiSelect = j["multiSelect"].bool,
            options = j["options"].arr.map { QuestionOption(it["label"].str ?: it.str.orEmpty(), it["description"].text) },
        )
    }
}

/** A question, or a tool permission the server renders as a three-option question. */
data class PendingQuestion(val id: String, val kind: String, val toolName: String?, val questions: List<Question>) {
    val isPermission get() = kind == "permission"

    companion object {
        fun of(j: JsonElement?): PendingQuestion? = j.obj?.let {
            PendingQuestion(it["id"].str.orEmpty(), it["kind"].str ?: "question", it["toolName"].text, it["questions"].arr.map(Question::of))
        }
    }
}

data class PendingPlan(val id: String, val plan: String) {
    companion object {
        fun of(j: JsonElement?): PendingPlan? = j.obj?.let { PendingPlan(it["id"].str.orEmpty(), it["plan"].str.orEmpty()) }
    }
}

data class SessionGroup(val mother: String?, val name: String?, val members: List<String>)

data class TodoSummary(val total: Int, val done: Int, val current: String?)

/** The prompt cache stays warm for `ttl` after the last request. */
data class CacheInfo(val lastRequestAt: Long, val ttlMs: Long) {
    fun remainingMs(now: Long) = lastRequestAt + ttlMs - now
}

data class Session(
    val id: String,
    val title: String?,
    val projectName: String?,
    val project: String?,
    val gitBranch: String?,
    val state: SessionState,
    val live: Boolean,
    val currentTool: String?,
    val activity: String?,
    val lastActivity: Long?,
    val lastPrompt: String?,
    val lastReply: String?,
    val model: String?,
    val effort: String?,
    val hasQuestion: Boolean,
    val hasPlan: Boolean,
    val question: PendingQuestion?,
    val cost: Double?,
    val followup: String?,
    val group: SessionGroup?,
    val todo: TodoSummary?,
    val cache: CacheInfo?,
) {
    val motherId get() = group?.mother ?: id
    val displayTitle get() = title ?: lastPrompt ?: projectName ?: "Untitled session"
    val needsYou get() = state == SessionState.ATTENTION || state == SessionState.WAITING || hasQuestion || hasPlan

    /** Fields whose change means the open conversation is stale. */
    val changeKey get() = "$lastActivity|$hasQuestion|$hasPlan|$followup|$state|$live"

    companion object {
        fun of(j: JsonElement?): Session {
            val question = PendingQuestion.of(j["question"])
            val g = j["group"].obj
            val td = j["todo"].obj
            val c = j["cache"].obj
            return Session(
                id = j["id"].str.orEmpty(),
                // The server falls back to a French placeholder when there is no title at all.
                title = j["title"].text?.takeIf { it != "(sans titre)" },
                projectName = j["projectName"].text,
                project = j["project"].text,
                gitBranch = j["gitBranch"].text,
                state = SessionState.of(j["state"].str),
                live = j["live"].bool,
                currentTool = j["currentTool"].text,
                activity = j["activity"].text,
                lastActivity = j["lastActivity"].millis ?: j["lastTs"].millis,
                lastPrompt = j["lastPrompt"].text,
                lastReply = j["lastReply"].text,
                model = j["model"].text,
                effort = j["effort"].text,
                hasQuestion = j["hasQuestion"].bool || question != null,
                hasPlan = j["hasPlan"].bool,
                question = question,
                cost = j["cost"].dbl,
                followup = j["followup"].text ?: j["followupSuggestion"].text,
                group = g?.let { SessionGroup(it["mother"].text, it["name"].text, it["members"].arr.mapNotNull { m -> m.str }) },
                todo = td?.let { TodoSummary(it["total"].int ?: 0, it["done"].int ?: 0, it["current"].text) },
                cache = c?.let { cache ->
                    val at = cache["lastRequestAt"].millis ?: return@let null
                    CacheInfo(at, if (cache["ttl"].str == "5m") 5 * 60_000L else 60 * 60_000L)
                },
            )
        }
    }
}

data class Tool(val id: String?, val name: String, val detail: String?, val inputText: String?, val result: String?) {
    companion object {
        fun of(j: JsonElement?): Tool {
            val r = j["result"]
            return Tool(
                id = j["id"].text,
                name = j["name"].str ?: "tool",
                detail = j["detail"].text,
                inputText = j["inputText"].text,
                result = if (r == null || r is kotlinx.serialization.json.JsonNull) null else r.str ?: r.toString(),
            )
        }
    }
}

sealed interface MessagePart {
    data class Text(val text: String) : MessagePart
    data class ToolUse(val tool: Tool) : MessagePart
}

data class Message(
    val id: Int,
    val role: String,
    val ts: Long?,
    val text: String,
    val truncated: Boolean,
    val tools: List<Tool>,
    val parts: List<MessagePart>,
    val kind: String?,
    val auto: Boolean,
) {
    /** Parts to render, rebuilt from text and tools when the server sent none. */
    val renderParts: List<MessagePart>
        get() = parts.ifEmpty { (if (text.isEmpty()) emptyList() else listOf(MessagePart.Text(text))) + tools.map(MessagePart::ToolUse) }

    companion object {
        fun of(index: Int, j: JsonElement?) = Message(
            id = index,
            role = j["role"].str ?: "system",
            ts = j["ts"].millis,
            text = j["text"].str.orEmpty(),
            truncated = j["truncated"].bool,
            tools = j["tools"].arr.map(Tool::of),
            parts = j["parts"].arr.mapNotNull { p ->
                when (p["type"].str) {
                    "text" -> p["text"].text?.let(MessagePart::Text)
                    "tool" -> p["tool"].obj?.let { MessagePart.ToolUse(Tool.of(it)) }
                    else -> null
                }
            },
            kind = j["kind"].text,
            auto = j["auto"].bool,
        )
    }
}

data class SubSession(val id: String, val label: String)

data class SessionDetail(
    val session: Session,
    val pendingQuestion: PendingQuestion?,
    val pendingPlan: PendingPlan?,
    val pendingLeadIn: String?,
    val permissionMode: String?,
    val autoApprove: Boolean,
    val messages: List<Message>,
    val subSessions: List<SubSession>,
) {
    companion object {
        fun of(j: JsonElement?) = SessionDetail(
            session = Session.of(j),
            pendingQuestion = PendingQuestion.of(j["pendingQuestion"]),
            pendingPlan = PendingPlan.of(j["pendingPlan"]),
            pendingLeadIn = j["pendingLeadIn"].text,
            permissionMode = j["permissionMode"].text,
            autoApprove = j["autoApprove"].bool,
            messages = j["messages"].arr.mapIndexed { i, m -> Message.of(i, m) },
            subSessions = j["subSessions"].arr.mapNotNull { s -> s["id"].str?.let { SubSession(it, s["label"].str.orEmpty()) } },
        )
    }
}

/** One frame of /api/session/stream: the turn in progress. */
data class LiveSnapshot(
    val live: Boolean = true,
    val state: String = "idle",
    val busy: Boolean = false,
    val activity: String? = null,
    val text: String = "",
    val thinking: String = "",
    val tool: String? = null,
    val ended: Boolean = false,
) {
    companion object {
        fun of(j: JsonElement?) = LiveSnapshot(
            live = j["live"]?.let { if (it is kotlinx.serialization.json.JsonNull) true else it.bool } ?: true,
            state = j["state"].str ?: "idle",
            busy = j["busy"].bool,
            activity = j["activity"].text,
            text = j["text"].str.orEmpty(),
            thinking = j["thinking"].str.orEmpty(),
            tool = j["tool"].text,
            ended = j["ended"].bool,
        )
    }
}

data class ModelOption(val id: String, val label: String)

data class ModelGroup(val label: String, val options: List<ModelOption>)

data class Capabilities(val models: List<ModelGroup> = emptyList(), val efforts: List<String> = emptyList()) {
    fun modelLabel(id: String): String {
        for (g in models) {
            val o = g.options.firstOrNull { it.id == id } ?: continue
            return if (o.id == g.label.lowercase()) g.label else "${g.label} ${o.label}"
        }
        return id.shortModel()
    }

    companion object {
        // Options are [id, label] tuples on the wire.
        fun of(j: JsonElement?) = Capabilities(
            models = j["models"].arr.map { g ->
                ModelGroup(g["label"].str.orEmpty(), g["opts"].arr.mapNotNull { o ->
                    val pair = o.arr
                    when {
                        pair.size >= 2 && pair[0].str != null -> ModelOption(pair[0].str!!, pair[1].str ?: pair[0].str!!)
                        o["id"].str != null -> ModelOption(o["id"].str!!, o["label"].str ?: o["id"].str!!)
                        o.str != null -> ModelOption(o.str!!, o.str!!)
                        else -> null
                    }
                })
            },
            efforts = j["efforts"].arr.mapNotNull { it.str },
        )
    }
}

data class Defaults(val model: String?, val effort: String?, val mode: String?)

/** One rate-limit window, as the dashboard's top bar gauges show it. */
data class Gauge(val label: String, val pct: Int, val resetInMin: Int?)

object PermissionMode {
    val live = listOf("default", "auto", "plan")
    val launch = listOf("default", "acceptEdits", "auto", "plan", "bypassPermissions", "dontAsk")

    fun label(m: String?) = when (m) {
        "default", null -> "Normal"
        "acceptEdits" -> "Accept edits"
        "auto" -> "Auto"
        "plan" -> "Plan"
        "bypassPermissions" -> "Bypass"
        "dontAsk" -> "Don't ask"
        else -> m
    }
}

/** "claude-opus-4-8" → "opus 4.8". */
fun String.shortModel(): String {
    if (!startsWith("claude-")) return this
    val parts = removePrefix("claude-").split('-')
    val ver = parts.drop(1).filter { it.length < 5 }.joinToString(".")
    return if (ver.isEmpty()) parts.first() else "${parts.first()} $ver"
}

/** "now", "4m", "3h", "2d". */
fun shortAge(millis: Long?, now: Long): String {
    if (millis == null) return ""
    val s = ((now - millis) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "now"
        s < 3600 -> "${s / 60}m"
        s < 86_400 -> "${s / 3600}h"
        else -> "${s / 86_400}d"
    }
}

fun usageGauges(j: JsonElement?): List<Gauge> {
    val a = j["account"].obj ?: return emptyList()
    fun gauge(label: String, g: JsonElement?) = g.obj?.let { o -> o["pct"].int?.let { Gauge(label, it, o["resetInMin"].int) } }
    return listOfNotNull(gauge("5H", a["fiveHour"]), gauge("7D", a["sevenDay"]), gauge(a["fable"]["label"].text ?: "Fable", a["fable"]))
}

/** Compact one-line rendering for values of unknown shape. */
fun JsonObject.display(): String = entries.joinToString("\n") { (k, v) -> "$k: ${v.str ?: v.toString()}" }
