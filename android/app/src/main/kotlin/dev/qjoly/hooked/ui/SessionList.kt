package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SubdirectoryArrowRight
import androidx.compose.material.icons.outlined.Traffic
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.data.shortAge
import dev.qjoly.hooked.state.AppModel
import kotlinx.coroutines.launch

/** A lead session and the members of its group. */
data class SessionUnit(val mother: Session, val children: List<Session>) {
    val all get() = listOf(mother) + children
}

private const val DAY = 86_400_000L

/** 0 needs you, 1 working, 2 idle, 3 ended, null hidden. */
fun bucket(s: Session, now: Long): Int? {
    // A session not driven by hooked and idle for a day is not waiting on anyone any more.
    val stale = !s.live && (s.lastActivity ?: 0) < now - DAY
    if (s.needsYou && !stale) return 0
    return when (s.state) {
        SessionState.WORKING, SessionState.BACKGROUND -> 1
        SessionState.ENDED, SessionState.PAST -> if ((s.lastActivity ?: 0) > now - DAY) 3 else null
        else -> 2
    }
}

/** Groups as units under their lead, members in group order. */
fun units(sessions: List<Session>): List<SessionUnit> {
    val byId = sessions.associateBy { it.id }
    return sessions.groupBy { it.motherId }.mapNotNull { (m, members) ->
        val mother = byId[m] ?: members.first()
        val rank = mother.group?.members.orEmpty()
        SessionUnit(mother, members.filter { it.id != mother.id }.sortedBy { rank.indexOf(it.id).let { i -> if (i < 0) Int.MAX_VALUE else i } })
    }
}

/** The six state hues of the icon's ring, one per project. */
private val ProjectHues = listOf(0xFFC43D4D, 0xFFE1901F, 0xFF418D50, 0xFF9E59B3, 0xFF92A1A9, 0xFF96684F).map(::Color)

fun projectHue(name: String?) = ProjectHues[Math.floorMod((name ?: "").hashCode(), ProjectHues.size)]

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListPane(app: AppModel, selected: String?, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var byProject by rememberSaveable { mutableStateOf(false) }
    var refreshing by rememberSaveable { mutableStateOf(false) }
    val collapsed = rememberSaveable { mutableStateOf(setOf("Ended")) }
    val q = query.trim().lowercase()
    val shown = app.visible.filter { s ->
        q.isEmpty() || listOfNotNull(s.displayTitle, s.projectName, s.gitBranch, s.lastPrompt).any { q in it.lowercase() }
    }
    val all = units(shown)

    Column(modifier.fillMaxSize()) {
        Row(Modifier.padding(start = 20.dp, end = 8.dp, top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Sessions", style = MaterialTheme.typography.headlineSmall, color = hooked.ink)
            Spacer(Modifier.width(8.dp))
            Text("${all.size}", style = MaterialTheme.typography.titleMedium, color = hooked.muted)
            Spacer(Modifier.weight(1f))
            IconButton({ byProject = !byProject }) {
                Icon(if (byProject) Icons.Outlined.Traffic else Icons.Outlined.Folder, if (byProject) "Group by state" else "Group by project", tint = hooked.muted)
            }
        }
        OutlinedTextField(
            query, { query = it },
            placeholder = { Text("Search sessions") },
            leadingIcon = { Icon(Icons.Outlined.Search, null) },
            trailingIcon = { if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Icons.Rounded.Close, "Clear") } },
            singleLine = true,
            shape = RoundedCornerShape(24.dp),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = hooked.card, unfocusedContainerColor = hooked.card, unfocusedBorderColor = hooked.line),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        )
        app.error?.let {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.CloudOff, null, Modifier.size(16.dp), tint = hooked.muted)
                Text(it, fontSize = 12.sp, color = hooked.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        PullToRefreshBox(
            refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    app.refresh()
                    refreshing = false
                }
            },
            Modifier.weight(1f),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 10.dp, end = 10.dp, bottom = 24.dp)) {
                val sections: List<Pair<String, List<SessionUnit>>> = if (byProject) {
                    all.filter { u -> u.all.any { bucket(it, now) != null } }
                        .groupBy { it.mother.projectName ?: "No project" }
                        .entries.sortedByDescending { e -> e.value.maxOf { it.mother.lastActivity ?: 0 } }
                        .map { it.key to it.value }
                } else {
                    val byBucket = all.groupBy { u -> u.all.mapNotNull { bucket(it, now) }.minOrNull() }
                    listOf("Needs you" to 0, "Working" to 1, "Idle" to 2, "Ended" to 3).map { (t, b) -> t to byBucket[b].orEmpty() }
                }
                sections.filter { it.second.isNotEmpty() }.forEach { (title, list) ->
                    section(title, list, byProject, title in collapsed.value, selected, now, onOpen) {
                        collapsed.value = if (title in collapsed.value) collapsed.value - title else collapsed.value + title
                    }
                }
                if (app.loaded && sections.all { it.second.isEmpty() }) {
                    item { Text(if (q.isEmpty()) "No sessions yet. Start one with +." else "Nothing matches.", color = hooked.muted, modifier = Modifier.padding(20.dp)) }
                }
            }
        }
    }
}

private fun LazyListScope.section(
    title: String, list: List<SessionUnit>, project: Boolean, folded: Boolean, selected: String?, now: Long,
    onOpen: (String) -> Unit, onToggle: () -> Unit,
) {
    item(key = "h:$title") {
        Row(
            Modifier.fillMaxWidth().clip12().clickable(onClick = onToggle).padding(start = 10.dp, end = 10.dp, top = 14.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp).rotate(if (folded) 0f else 90f), tint = hooked.muted)
            if (project) Box(Modifier.size(14.dp, 8.dp).background(projectHue(title), RoundedCornerShape(2.dp)))
            Text(title, style = MaterialTheme.typography.titleSmall, color = hooked.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text("${list.size}", fontSize = 12.sp, color = hooked.muted)
        }
    }
    if (folded) return
    list.forEach { u ->
        item(key = "s:${u.mother.id}") { SessionRow(u.mother, u.mother.id == selected, now, child = false) { onOpen(u.mother.id) } }
        items(u.children, key = { "c:${it.id}" }) { c -> SessionRow(c, c.id == selected, now, child = true) { onOpen(c.id) } }
    }
}

private fun Modifier.clip12() = clip(RoundedCornerShape(12.dp))

/** The pill a session in need wears: what it is blocked on. */
fun decisionLabel(s: Session): String? = when {
    s.hasPlan -> "Plan"
    s.question?.isPermission == true -> "Permission"
    s.hasQuestion -> "Question"
    s.state == SessionState.ATTENTION -> "Action"
    else -> null
}

@Composable
fun SessionRow(s: Session, selected: Boolean, now: Long, child: Boolean, onClick: () -> Unit) {
    val style = decisionLabel(s)?.let { decisionStyle() } ?: stateStyle(s.state)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 1.dp)
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent, RoundedCornerShape(12.dp))
            .clip12().clickable(onClick = onClick)
            .padding(start = if (child) 26.dp else 12.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (child) Icon(Icons.Outlined.SubdirectoryArrowRight, null, Modifier.size(14.dp).padding(top = 2.dp), tint = hooked.muted)
        StateDot(style, Modifier.padding(top = 5.dp), 9.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    s.displayTitle, style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp), color = hooked.ink,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Text(shortAge(s.lastActivity, now), fontSize = 12.sp, color = hooked.muted, modifier = Modifier.padding(start = 8.dp))
            }
            if (!child) {
                val meta = listOfNotNull(s.projectName, s.gitBranch).joinToString(" · ")
                if (meta.isNotEmpty()) Text(meta, fontFamily = Mono, fontSize = 11.5.sp, color = hooked.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            decisionLabel(s)?.let { StatePill(style, Modifier.padding(top = 4.dp), it) }
                ?: (s.activity ?: s.currentTool ?: s.todo?.current)?.takeIf { s.state == SessionState.WORKING }?.let {
                    Text(it, fontSize = 12.sp, color = stateStyle(SessionState.WORKING).ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
        }
    }
}
