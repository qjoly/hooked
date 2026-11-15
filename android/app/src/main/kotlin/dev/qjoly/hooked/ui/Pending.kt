package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.HookedClient.Selection
import dev.qjoly.hooked.data.PendingPlan
import dev.qjoly.hooked.data.PendingQuestion
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.composePlanFeedback
import dev.qjoly.hooked.state.planPassages
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.session.RuneMarkdown

// session.rs `question`, `plan` and `card`: what waits on you, above the composer.

@Composable
private fun Card(accent: Color, content: @Composable ColumnScope.() -> Unit) {
    val c = k.c
    val shape = RoundedCornerShape(k.r.lg)
    Column(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 10.dp)
            .shadow(3.dp, shape, ambientColor = c.shadow, spotColor = c.shadow)
            .clip(shape).background(c.surface).border(1.dp, accent, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
private fun CardHead(dot: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Dot(dot, 8.dp)
        Text(label, style = k.ty.uiMedium, color = k.c.fg)
    }
}

@Composable
fun PendingCards(model: SessionModel) {
    val d = model.detail ?: return
    d.pendingQuestion?.let { q -> if (q.isPermission) PermissionCard(model, q) else QuestionCard(model, q) }
    d.pendingPlan?.let { PlanCard(model, it) }
}

/** The option order is the server's contract: 0 allow once, 1 allow always, 2 deny. */
@Composable
private fun PermissionCard(model: SessionModel, q: PendingQuestion) {
    val c = k.c
    fun pick(i: Int) = model.answer(listOf(Selection(false, listOf(i))), done = listOf("✓ Allowed once", "✓ Always allowed", "✓ Denied")[i])
    Card(c.warning.border) {
        CardHead(c.warning.hue, "Permission · ${q.toolName ?: "a tool"}")
        Text(q.questions.firstOrNull()?.question.orEmpty(), style = k.ty.mono, color = c.muted)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KButton("Allow once", { pick(0) }, variant = Variant.CONTRAST, size = Size.REGULAR, enabled = !model.sending)
            KButton("Allow always", { pick(1) }, variant = Variant.NEUTRAL, size = Size.REGULAR, enabled = !model.sending)
            KButton("Deny", { pick(2) }, variant = Variant.DANGER, size = Size.REGULAR, enabled = !model.sending)
        }
    }
}

@Composable
private fun QuestionCard(model: SessionModel, q: PendingQuestion) {
    val c = k.c
    val picked = remember(q.id) { mutableStateListOf<Set<Int>>().apply { repeat(q.questions.size) { add(emptySet()) } } }
    var other by remember(q.id) { mutableStateOf("") }
    val maxBody = (LocalConfiguration.current.screenHeightDp * 0.45f).coerceAtLeast(200f).dp
    fun answer() {
        val note = other.trim()
        model.answer(q.questions.mapIndexed { i, qq -> Selection(qq.multiSelect, picked.getOrElse(i) { emptySet() }.sorted(), note.takeIf { i == 0 && it.isNotEmpty() }) })
    }
    Card(c.warning.border) {
        CardHead(c.warning.hue, "Claude is asking")
        Column(Modifier.fillMaxWidth().heightIn(max = maxBody).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            q.questions.forEachIndexed { qi, qq ->
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    qq.header?.let { Pill(it, c.muted, c.chip) }
                    Text(qq.question, style = k.ty.bodyMedium, color = c.fg)
                    qq.options.forEachIndexed { oi, o ->
                        val on = oi in picked[qi]
                        val shape = RoundedCornerShape(k.r.md)
                        Row(
                            Modifier.fillMaxWidth().clip(shape).background(if (on) c.chip else Color.Transparent)
                                .border(1.dp, if (on) c.accent else c.border, shape)
                                .clickable { picked[qi] = if (qq.multiSelect) picked[qi].let { if (oi in it) it - oi else it + oi } else setOf(oi) }
                                .padding(10.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            KIcon(if (on) Lucide.CircleCheck else Lucide.Circle, if (on) c.fg else c.faint, 16.dp, Modifier.padding(top = 2.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(o.label, style = k.ty.uiMedium, color = c.fg)
                                o.description?.let { Text(it, style = k.ty.textSmall, color = c.muted) }
                            }
                        }
                    }
                }
            }
        }
        KTextInput(other, { other = it }, "Other: type your own answer…", Modifier.fillMaxWidth(), onSubmit = ::answer)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            KButton("Answer", ::answer, variant = Variant.CONTRAST, size = Size.REGULAR, enabled = !model.sending)
        }
    }
}

@Composable
private fun PlanCard(model: SessionModel, p: PendingPlan) {
    val c = k.c
    var feedback by remember(p.id) { mutableStateOf("") }
    var quote by remember(p.id) { mutableStateOf<String?>(null) }
    var picking by remember(p.id) { mutableStateOf(false) }
    val comments = remember(p.id) { mutableStateListOf<Pair<String, String>>() }
    fun keepPlanning() {
        val note = feedback.trim()
        quote?.takeIf { note.isNotEmpty() }?.let { comments += it to note }
        val text = if (comments.isEmpty()) note else composePlanFeedback(comments)
        model.plan(if (text.isEmpty()) "keep" else "keep-feedback", text.ifEmpty { null })
    }
    Card(c.info.border) {
        CardHead(c.stateColor("working"), "Plan ready for review")
        Column(Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
            SelectionContainer { RuneMarkdown(p.plan.ifEmpty { "_Empty plan_" }) }
        }
        comments.forEachIndexed { i, (q, note) ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    QuoteLine(q)
                    Text(note, style = k.ty.textSmall, color = c.fg)
                }
                KButton("Remove", { comments.removeAt(i) }, variant = Variant.GHOST_FAINT, size = Size.SMALL)
            }
        }
        quote?.let { QuoteLine(it) }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val q = quote
            if (q != null) {
                KButton("Add the comment", {
                    val note = feedback.trim()
                    if (note.isNotEmpty()) {
                        comments += q to note
                        quote = null
                        feedback = ""
                    }
                }, variant = Variant.OUTLINE, size = Size.SMALL)
                KButton("Drop the quote", { quote = null }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
            } else {
                // Selections cannot be read back on a tablet: the passage is picked from a list.
                KButton("Comment on a passage", { picking = true }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Converse)
            }
            if (comments.isNotEmpty()) {
                Spacer(Modifier.weight(1f))
                Text("${comments.size} comment${if (comments.size == 1) "" else "s"} go out with Keep planning", style = k.ty.textXsmall, color = c.faint)
            }
        }
        KTextInput(
            feedback, { feedback = it },
            if (quote != null) "Your comment on the quoted passage…" else "Feedback (sent when you keep planning)…",
            Modifier.fillMaxWidth(),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            KButton("Keep planning", ::keepPlanning, variant = Variant.OUTLINE, size = Size.REGULAR, enabled = !model.sending)
            KButton("Approve · accept edits", { model.plan("approve") }, variant = Variant.NEUTRAL, size = Size.REGULAR, enabled = !model.sending)
            KButton("Approve · auto", { model.plan("approve-auto") }, variant = Variant.CONTRAST, size = Size.REGULAR, enabled = !model.sending)
        }
    }
    if (picking) {
        val passages = remember(p.plan) { planPassages(p.plan) }
        KModal({ picking = false }, "Comment on a passage") {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                passages.forEach { s ->
                    Pressable({ quote = s; picking = false }, Modifier.fillMaxWidth(), radius = k.r.md) {
                        Text(s, style = k.ty.textSmall, color = k.c.fg, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun QuoteLine(q: String) {
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(k.c.border2))
        Text(q, style = k.ty.textSmall, color = k.c.muted, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp))
    }
}
