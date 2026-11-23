package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.Message
import dev.qjoly.hooked.data.MessagePart
import dev.qjoly.hooked.data.Meta
import dev.qjoly.hooked.data.PendingQuestion
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.SessionState

// desktop's quick.rs: a small window to answer the sessions that wait on you without opening them.

/** What needs you, not archived and not gone cold, twelve at most. */
fun quickItems(sessions: List<Session>, meta: Map<String, Meta>, now: Long) =
    sessions.filter { it.needsYou && !meta.of(it.id).archived && !isCold(it, now) }.take(12)

/** Why a session is listed: its question, else what it waits for. */
fun quickReason(s: Session) = s.question?.questions?.firstOrNull()?.question?.takeIf { it.isNotBlank() } ?: when {
    s.hasPlan -> "plan to review"
    s.state == SessionState.ATTENTION -> "action required"
    else -> "finished its turn"
}

data class QuickMsg(val user: Boolean, val text: String)

/** The last ten messages as markdown, tools as "`name` detail", then the pending question and its numbered options. */
fun quickMessages(messages: List<Message>, pending: PendingQuestion?): List<QuickMsg> {
    val out = messages.takeLast(10).mapNotNull { m ->
        if (m.role == "system") return@mapNotNull null
        val parts = m.renderParts.map { p ->
            when (p) {
                is MessagePart.Text -> p.text
                is MessagePart.ToolUse -> "`${p.tool.name}` ${p.tool.detail.orEmpty()}"
            }
        }
        if (parts.isEmpty()) null else QuickMsg(m.role == "user", parts.joinToString("\n\n"))
    }.toMutableList()
    pending?.questions?.firstOrNull()?.let { q ->
        val opts = q.options.mapIndexed { i, o -> "${i + 1}. ${o.label}" }.joinToString("\n")
        out += QuickMsg(false, "**${q.question}**\n\n$opts")
    }
    return out
}

/** ↑ / ↓ cycle through the list. */
fun quickStep(at: Int, size: Int, delta: Int) = if (size == 0) 0 else ((at + delta) % size + size) % size
