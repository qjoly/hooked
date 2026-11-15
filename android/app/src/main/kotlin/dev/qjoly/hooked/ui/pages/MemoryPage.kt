package dev.qjoly.hooked.ui.pages

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.Memory
import dev.qjoly.hooked.data.count
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.filterMemories
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.memory
import dev.qjoly.hooked.data.memoryProjects
import dev.qjoly.hooked.data.obj
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.k
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

class MemoryModel : PageModel() {
    var memory by mutableStateOf<JsonElement?>(null)
        private set
    var project by mutableIntStateOf(0)
    var open by mutableStateOf<String?>(null)
    var query by mutableStateOf("")
    var type by mutableStateOf<String?>(null)

    /** Refetches on every visit; the last result stays on screen meanwhile. */
    fun enter(app: AppModel) {
        call(app, "Memory") { c ->
            try {
                memory = c.memory()
            } catch (e: Exception) {
                if (memory == null) memory = JsonNull
                throw e
            }
        }
    }

    fun search(q: String) {
        query = q
        project = 0
    }

    fun toggleType(t: String) {
        project = 0
        type = if (type == t) null else t
    }
}

/** rune's Memory page: projects with memories on the left, a project's memory files on the right. */
@Composable
fun MemoryPage(app: AppModel) {
    val m: MemoryModel = viewModel()
    LaunchedEffect(Unit) { m.enter(app) }
    val v = m.memory
    if (v == null) {
        PageFrame("Memory") { PageLoading() }
        return
    }
    val all = remember(v) { memoryProjects(v) }
    val projects = remember(all, m.type, m.query) { filterMemories(all, m.type, m.query) }
    PageFrame("Memory · ${count(v["total"].dbl)}") {
        Row(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.sideList(260.dp, k.c.border), contentPadding = PaddingValues(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                itemsIndexed(projects) { i, p ->
                    val on = i == m.project
                    Pressable(
                        { m.project = i; m.open = null },
                        Modifier.fillMaxWidth().height(34.dp),
                        // The desktop's hover help (the project path) is shown on long-press.
                        onLongClick = { p.cwd?.let { app.say(it) } },
                        fill = if (on) k.c.chip else Color.Transparent,
                    ) {
                        Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            KIcon(Lucide.Folder, k.c.muted, 13.dp)
                            Text(p.name, style = k.ty.ui, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(p.memories.size.toString(), style = k.ty.textXsmall, color = k.c.faint)
                        }
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                MemoryDetail(app, m, v, projects.getOrNull(m.project))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MemoryDetail(app: AppModel, m: MemoryModel, v: JsonElement, p: dev.qjoly.hooked.data.MemoryProject?) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Column(Modifier.widthIn(max = 900.dp).fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                KTextInput(m.query, m::search, "Search memories…", Modifier.width(260.dp))
                for ((t, n) in v["byType"].obj.orEmpty()) PageChip("$t ${n.int ?: 0}", m.type == t) { m.toggleType(t) }
            }
            if (p != null) {
                p.cwd?.let { Text(it, style = k.ty.textSmall, color = k.c.faint) }
                for (mem in p.memories) MemoryCard(app, m, mem)
            }
        }
    }
}

@Composable
private fun MemoryCard(app: AppModel, m: MemoryModel, mem: Memory) {
    val open = m.open == mem.file
    PageBox {
        Pressable({ m.open = if (open) null else mem.file }, Modifier.fillMaxWidth(), radius = k.r.sm) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Pill(mem.type, k.c.muted, k.c.chip)
                Text(mem.name, style = k.ty.uiMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(mem.file, style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
            }
        }
        mem.description?.let { Text(it, style = k.ty.textSmall, color = k.c.muted) }
        if (open) PageMarkdown(app, mem.body, selectable = true)
    }
}
