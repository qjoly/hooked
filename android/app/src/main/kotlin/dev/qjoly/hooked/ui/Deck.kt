package dev.qjoly.hooked.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardReturn
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Coffee
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Snooze
import androidx.compose.material3.Button
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.data.shortAge
import dev.qjoly.hooked.state.AppModel

/** What waits on you, then the whole fleet: the web's Deck. */
@Composable
fun DeckScreen(app: AppModel) {
    val now = rememberNow()
    val decisions = app.visible
        .filter { bucket(it, now) == 0 && !app.isSnoozed(it.id, now) }
        .sortedWith(compareBy<Session> { if (decisionLabel(it) != null) 0 else 1 }.thenByDescending { it.lastActivity ?: 0 })
    val fleet = units(app.visible.filter { bucket(it, now) != null })

    BoxWithConstraints(Modifier.fillMaxSize()) {
        if (maxWidth >= 1000.dp) {
            Row(Modifier.fillMaxSize()) {
                LazyColumn(Modifier.weight(1.15f), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    yourMove(app, decisions, now)
                }
                LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(top = 24.dp, end = 24.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    theFleet(app, fleet, decisions.size, now)
                }
            }
        } else {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                yourMove(app, decisions, now)
                theFleet(app, fleet, decisions.size, now)
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String, detail: String, action: @Composable () -> Unit = {}) {
    Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.headlineMedium, color = hooked.ink)
        Spacer(Modifier.width(10.dp))
        Text(detail, style = MaterialTheme.typography.titleSmall, color = hooked.muted, modifier = Modifier.padding(bottom = 5.dp))
        Spacer(Modifier.weight(1f))
        action()
    }
}

private fun LazyListScope.yourMove(app: AppModel, decisions: List<Session>, now: Long) {
    item(key = "move") {
        SectionTitle("Your move", if (decisions.size == 1) "1 decision" else "${decisions.size} decisions") {
            if (decisions.isNotEmpty()) {
                TextButton({ decisions.forEach { app.snooze(it.id, 1) } }) {
                    Icon(Icons.Outlined.Snooze, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Snooze all 1h")
                }
            }
        }
    }
    if (decisions.isEmpty()) {
        item(key = "calm") {
            Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = hooked.card, border = BorderStroke(1.dp, hooked.line)) {
                Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Outlined.Coffee, null, Modifier.size(36.dp), tint = hooked.muted)
                    Text("Nothing waits on you", style = MaterialTheme.typography.titleMedium, color = hooked.ink)
                    Text("Sessions that finish a turn or ask something show up here.", color = hooked.muted, fontSize = 13.sp)
                }
            }
        }
    }
    items(decisions, key = { "d:${it.id}" }) { DecisionCard(app, it, now) }
}

@Composable
private fun DecisionCard(app: AppModel, s: Session, now: Long) {
    val label = decisionLabel(s)
    val style = if (label != null) decisionStyle() else stateStyle(SessionState.WAITING)
    var replying by rememberSaveable(s.id) { mutableStateOf(false) }
    var reply by rememberSaveable(s.id) { mutableStateOf("") }
    Surface(
        Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        color = hooked.card,
        border = BorderStroke(1.dp, style.hue.copy(alpha = 0.5f)),
        shadowElevation = 1.dp,
    ) {
        Column {
            Row(Modifier.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatePill(style, label = label ?: "Waiting")
                Text(
                    s.displayTitle, style = MaterialTheme.typography.titleMedium.copy(fontSize = 17.sp), color = hooked.ink,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).clickable { app.open(s.id) },
                )
                Text(shortAge(s.lastActivity, now).let { if (it == "now") "just now" else "$it ago" }, fontSize = 12.sp, color = hooked.muted)
            }
            listOfNotNull(s.projectName, s.gitBranch).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                Text(it, fontFamily = Mono, fontSize = 12.sp, color = hooked.muted, modifier = Modifier.padding(start = 18.dp, end = 18.dp, bottom = 12.dp).padding(top = 0.dp))
            }
            HorizontalDivider(color = hooked.line)
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val q = s.question
                when {
                    q != null && q.isPermission -> {
                        Lead("Claude is waiting for a permission.", style.ink)
                        PermissionCard(q, enabled = true, header = false) { sel, note -> app.act { it.answer(s.id, sel, note) } }
                    }
                    q != null -> {
                        Lead("Claude is asking you a question.", style.ink)
                        QuestionCard(q, enabled = true, header = false) { sel, note -> app.act { it.answer(s.id, sel, note) } }
                    }
                    else -> {
                        Lead(
                            when {
                                s.hasPlan -> "A plan is ready for review."
                                s.state == SessionState.ATTENTION -> "Action required."
                                else -> "Waiting for you"
                            },
                            style.ink,
                        )
                        Excerpts(s, 3)
                    }
                }
            }
            HorizontalDivider(color = hooked.line)
            Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (s.question == null && !s.hasPlan) {
                    Button({ replying = !replying }) {
                        Icon(Icons.AutoMirrored.Rounded.KeyboardReturn, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Reply")
                    }
                }
                OutlinedButton({ app.open(s.id) }) {
                    Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Open the session")
                }
                OutlinedButton({ app.snooze(s.id, 1) }) {
                    Icon(Icons.Outlined.Snooze, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("1h")
                }
                OutlinedButton({ app.archive(s.id) }) {
                    Icon(Icons.Outlined.Archive, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Archive")
                }
            }
            if (replying) {
                Row(Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        reply, { reply = it }, placeholder = { Text(s.followup ?: "Reply to Claude…") },
                        maxLines = 6, shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f),
                    )
                    FilledIconButton(
                        {
                            val text = reply.trim().ifEmpty { s.followup.orEmpty() }
                            if (text.isEmpty()) return@FilledIconButton
                            reply = ""
                            replying = false
                            // A session hooked does not drive takes the reply through a resume.
                            app.act { if (s.live) it.reply(s.id, text) else it.resume(s.id, text, s.effort) }
                        },
                        Modifier.size(48.dp),
                    ) { Icon(Icons.AutoMirrored.Rounded.Send, "Send") }
                }
            }
        }
    }
}

@Composable
private fun Lead(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text, style = MaterialTheme.typography.titleMedium, color = color)
}

/** Your last message on the right, Claude's last reply on the left, as on the web. */
@Composable
private fun Excerpts(s: Session, lines: Int, indent: androidx.compose.ui.unit.Dp = 48.dp) {
    s.lastPrompt?.let(::plain)?.let {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Text(
                it, fontSize = 13.sp, color = hooked.ink, maxLines = lines, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = indent).background(hooked.crema, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
    s.lastReply?.let(::plain)?.let {
        Text(
            it, fontSize = 13.sp, color = hooked.muted, maxLines = lines + 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(end = indent).background(hooked.panel, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

private val Emphasis = Regex("\\*\\*|__|`")
private val HeadingMark = Regex("^#+\\s*", RegexOption.MULTILINE)
private val Bullet = Regex("^\\s*[-*]\\s+", RegexOption.MULTILINE)
private val Space = Regex("\\s+")

/** Markdown flattened to one line, so an excerpt reads as text. */
fun plain(md: String) = md.replace(Emphasis, "").replace(HeadingMark, "").replace(Bullet, "• ").replace(Space, " ").trim()

/** The families the fleet ring counts, in the web's order. */
private data class Family(val label: String, val state: SessionState, val decision: Boolean = false)

private val Families = listOf(
    Family("Action required", SessionState.ATTENTION, decision = true),
    Family("Waiting for you", SessionState.WAITING),
    Family("Working", SessionState.WORKING),
    Family("Background", SessionState.BACKGROUND),
    Family("Paused", SessionState.IDLE),
    Family("Ended", SessionState.ENDED),
)

private fun familyOf(s: Session): Int = when {
    decisionLabel(s) != null -> 0
    s.needsYou -> 1
    s.state == SessionState.WORKING -> 2
    s.state == SessionState.BACKGROUND -> 3
    s.state == SessionState.ENDED || s.state == SessionState.PAST -> 5
    else -> 4
}

@OptIn(ExperimentalLayoutApi::class)
private fun LazyListScope.theFleet(app: AppModel, fleet: List<SessionUnit>, decisions: Int, now: Long) {
    val sessions = fleet.flatMap { it.all }
    val byProject = fleet.groupBy { it.mother.projectName ?: "No project" }
        .entries.sortedByDescending { e -> e.value.maxOf { it.mother.lastActivity ?: 0 } }
    item(key = "fleet") {
        val active = sessions.count { it.state == SessionState.WORKING || it.state == SessionState.BACKGROUND }
        SectionTitle("The fleet", "${byProject.size} groups · $active active")
    }
    item(key = "ring") { FleetRing(sessions, decisions) }
    byProject.forEach { (project, units) ->
        item(key = "p:$project") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 6.dp)) {
                    Box(Modifier.size(18.dp, 9.dp).background(projectHue(project), RoundedCornerShape(2.dp)))
                    Text(project, style = MaterialTheme.typography.titleMedium, color = hooked.ink)
                    Text("${units.size}", fontSize = 13.sp, color = hooked.muted)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp), maxItemsInEachRow = 2) {
                    units.forEach { FleetCard(app, it, now, Modifier.weight(1f)) }
                    // An odd card keeps half the width instead of stretching across.
                    if (units.size % 2 == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun FleetRing(sessions: List<Session>, decisions: Int) {
    val counts = IntArray(Families.size).also { c -> sessions.forEach { c[familyOf(it)]++ } }
    val styles = Families.map { if (it.decision) decisionStyle() else stateStyle(it.state) }
    val empty = hooked.line
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = hooked.card, border = BorderStroke(1.dp, hooked.line)) {
        Row(Modifier.padding(24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(28.dp)) {
            Box(Modifier.size(150.dp), contentAlignment = Alignment.Center) {
                Canvas(Modifier.size(150.dp)) {
                    val stroke = 18.dp.toPx()
                    val inset = stroke / 2
                    val arc = Size(size.width - stroke, size.height - stroke)
                    val total = counts.sum()
                    if (total == 0) {
                        drawArc(empty, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(stroke))
                        return@Canvas
                    }
                    var start = -90f
                    val gap = if (counts.count { it > 0 } > 1) 2f else 0f
                    counts.forEachIndexed { i, n ->
                        if (n == 0) return@forEachIndexed
                        val sweep = 360f * n / total
                        drawArc(styles[i].hue, start + gap / 2, sweep - gap, false, Offset(inset, inset), arc, style = Stroke(stroke, cap = StrokeCap.Butt))
                        start += sweep
                    }
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("$decisions", style = MaterialTheme.typography.displaySmall, color = hooked.ink)
                    Text(if (decisions == 1) "decision" else "decisions", fontSize = 12.sp, color = hooked.muted)
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Families.indices.chunked(2).forEach { pair ->
                    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                        pair.forEach { i ->
                            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                StateDot(styles[i].copy(pulses = false), size = 10.dp)
                                Text(Families[i].label, fontSize = 14.sp, color = hooked.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                Text("${counts[i]}", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = hooked.ink)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FleetCard(app: AppModel, u: SessionUnit, now: Long, modifier: Modifier) {
    val s = u.mother
    val style = decisionLabel(s)?.let { decisionStyle() } ?: stateStyle(s.state)
    Surface(
        modifier.clip(MaterialTheme.shapes.large).clickable { app.open(s.id) },
        shape = MaterialTheme.shapes.large, color = hooked.card, border = BorderStroke(1.dp, hooked.line),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StateDot(style, size = 9.dp)
                Text(s.displayTitle, style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp), color = hooked.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(shortAge(s.lastActivity, now), fontSize = 12.sp, color = hooked.muted)
            }
            s.todo?.takeIf { it.total > 0 }?.let { Text("${it.current ?: "Tasks"} (${it.done}/${it.total})", fontSize = 12.sp, color = hooked.muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            Excerpts(s, 2, indent = 20.dp)
            if (u.children.isNotEmpty()) Text("+ ${u.children.size} in this group", fontSize = 12.sp, color = hooked.muted)
        }
    }
}
