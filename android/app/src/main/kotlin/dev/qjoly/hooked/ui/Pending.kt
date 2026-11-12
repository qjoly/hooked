package dev.qjoly.hooked.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.data.HookedClient.Selection
import dev.qjoly.hooked.data.PendingPlan
import dev.qjoly.hooked.data.PendingQuestion
import dev.qjoly.hooked.data.QuestionOption

/** A question, permission or plan waiting on the user, framed in the attention family. */
@Composable
fun DecisionFrame(content: @Composable () -> Unit) {
    val style = decisionStyle()
    Surface(
        Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        color = hooked.card,
        border = BorderStroke(1.dp, style.hue.copy(alpha = 0.45f)),
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
    }
}

@Composable
private fun Header(label: String, detail: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatePill(decisionStyle(), label = label)
        detail?.let { Text(it, fontFamily = Mono, fontSize = 12.sp, color = hooked.muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

/** Option order is the server contract: 0 allow once, 1 allow always, 2 deny. */
@Composable
fun PermissionCard(ask: PendingQuestion, enabled: Boolean, header: Boolean = true, onAnswer: (List<Selection>, String?) -> Unit) {
    var denying by remember { mutableStateOf(false) }
    if (header) Header("Permission", ask.toolName)
    Text(
        ask.questions.firstOrNull()?.question ?: "Claude wants to use ${ask.toolName ?: "a tool"}",
        style = MaterialTheme.typography.titleMedium, color = hooked.ink,
    )
    ask.questions.firstOrNull()?.options?.firstOrNull()?.description?.takeIf { it != "Run this call only." }?.let {
        Text(it, fontFamily = Mono, fontSize = 12.sp, color = hooked.muted, maxLines = 6, overflow = TextOverflow.Ellipsis)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button({ onAnswer(listOf(Selection(false, listOf(0))), null) }, enabled = enabled) { Text("Allow once") }
        OutlinedButton({ onAnswer(listOf(Selection(false, listOf(1))), null) }, enabled = enabled) { Text("Allow always") }
        OutlinedButton({ denying = true }, enabled = enabled) { Text("Deny") }
    }
    if (denying) {
        var reason by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { denying = false },
            title = { Text("Deny this call?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Claude reads the reason and picks another route.")
                    OutlinedTextField(reason, { reason = it }, label = { Text("Reason (optional)") }, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton({
                    denying = false
                    onAnswer(listOf(Selection(false, listOf(2))), reason.trim().ifEmpty { null })
                }) { Text("Deny") }
            },
            dismissButton = { TextButton({ denying = false }) { Text("Cancel") } },
        )
    }
}

@Composable
fun QuestionCard(ask: PendingQuestion, enabled: Boolean, header: Boolean = true, onAnswer: (List<Selection>, String?) -> Unit) {
    val picked = remember(ask.id) { mutableStateListOf<Set<Int>>().apply { repeat(ask.questions.size) { add(emptySet()) } } }
    val other = remember(ask.id) { mutableStateListOf<String>().apply { repeat(ask.questions.size) { add("") } } }
    if (header) Header("Question")
    ask.questions.forEachIndexed { qi, q ->
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            q.header?.let { Text(it.uppercase(), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = hooked.muted, letterSpacing = 0.6.sp) }
            Text(q.question, style = MaterialTheme.typography.titleMedium, color = hooked.ink)
            q.options.forEachIndexed { oi, o ->
                OptionRow(o, on = oi in picked[qi], multi = q.multiSelect, enabled = enabled) {
                    picked[qi] = if (q.multiSelect) picked[qi].let { if (oi in it) it - oi else it + oi } else setOf(oi)
                }
            }
            OutlinedTextField(
                other[qi], { other[qi] = it }, placeholder = { Text("Other…") }, enabled = enabled,
                modifier = Modifier.fillMaxWidth(), maxLines = 4, textStyle = MaterialTheme.typography.bodyMedium,
            )
        }
    }
    val complete = ask.questions.indices.all { picked[it].isNotEmpty() || other[it].isNotBlank() }
    Button(
        {
            onAnswer(ask.questions.indices.map { Selection(ask.questions[it].multiSelect, picked[it].sorted(), other[it].trim().ifEmpty { null }) }, null)
        },
        enabled = enabled && complete,
    ) { Text("Send answer") }
}

@Composable
private fun OptionRow(option: QuestionOption, on: Boolean, multi: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .background(if (on) hooked.crema else Color.Transparent, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (multi) Checkbox(on, { onClick() }, enabled = enabled) else RadioButton(on, onClick, enabled = enabled)
        Column(Modifier.padding(vertical = 6.dp)) {
            Text(option.label, style = MaterialTheme.typography.titleSmall, color = hooked.ink)
            option.description?.let { Text(it, fontSize = 12.5.sp, color = hooked.muted) }
        }
    }
}

@Composable
fun PlanCard(plan: PendingPlan, enabled: Boolean, onPlan: (String, String?) -> Unit) {
    var feedback by remember { mutableStateOf<String?>(null) }
    Header("Plan")
    Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
        MarkdownBody(plan.plan.ifEmpty { "_Empty plan_" })
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button({ onPlan("approve", null) }, enabled = enabled) { Text("Approve") }
        OutlinedButton({ onPlan("approve-auto", null) }, enabled = enabled) { Text("Approve (auto)") }
        OutlinedButton({ onPlan("keep", null) }, enabled = enabled) { Text("Keep planning") }
        TextButton({ feedback = "" }, enabled = enabled) { Text("With feedback…") }
    }
    feedback?.let { f ->
        AlertDialog(
            onDismissRequest = { feedback = null },
            title = { Text("Keep planning with feedback") },
            text = { OutlinedTextField(f, { feedback = it }, label = { Text("Feedback") }, minLines = 3, modifier = Modifier.fillMaxWidth()) },
            confirmButton = {
                TextButton({
                    feedback = null
                    onPlan("keep-feedback", f.trim())
                }, enabled = f.isNotBlank()) { Text("Send") }
            },
            dismissButton = { TextButton({ feedback = null }) { Text("Cancel") } },
        )
    }
}
