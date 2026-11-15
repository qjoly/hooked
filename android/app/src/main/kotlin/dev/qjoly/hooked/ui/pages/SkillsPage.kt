package dev.qjoly.hooked.ui.pages

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.firstLine
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.skill
import dev.qjoly.hooked.data.skillGroups
import dev.qjoly.hooked.data.skillMeta
import dev.qjoly.hooked.data.skills
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

class SkillsModel : PageModel() {
    var skills by mutableStateOf<List<JsonElement>?>(null)
        private set
    var open by mutableStateOf<String?>(null)
        private set
    var skill by mutableStateOf<JsonElement?>(null)
        private set
    var query by mutableStateOf("")
    private var opening: Job? = null

    /** Project skills come from every project a session ran in, as rune's `projects()`. */
    private fun cwds(app: AppModel) = app.sessions.mapNotNull { it.project }.distinct()

    fun enter(app: AppModel) {
        call(app, "Skills") { c ->
            val list = try {
                c.skills(cwds(app))
            } catch (e: Exception) {
                if (skills == null) skills = emptyList()
                throw e
            }
            skills = list
            if (open == null || list.none { it["id"].str == open }) list.firstOrNull()?.get("id").str?.let { openSkill(app, it) }
        }
    }

    fun openSkill(app: AppModel, id: String) {
        open = id
        skill = null
        opening?.cancel()
        opening = call(app, "Skill") { skill = it.skill(id, cwds(app)) }
    }
}

/** rune's Skills page: skills grouped by source on the left, the open one's frontmatter and body on the right. */
@Composable
fun SkillsPage(app: AppModel) {
    val m: SkillsModel = viewModel()
    LaunchedEffect(Unit) { m.enter(app) }
    val list = m.skills
    if (list == null) {
        PageFrame("Skills") { PageLoading() }
        return
    }
    val groups = remember(list, m.query) { skillGroups(list, m.query) }
    PageFrame("Skills · ${list.size}") {
        Row(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.sideList(300.dp, k.c.border), contentPadding = PaddingValues(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                item { KTextInput(m.query, { m.query = it }, "Search skills…", Modifier.fillMaxWidth()) }
                for ((src, items) in groups) {
                    item(key = "src-$src") {
                        Box(Modifier.padding(start = 6.dp, end = 6.dp, top = 8.dp, bottom = 4.dp)) { SectionTitle(src.uppercase()) }
                    }
                    items(items, key = { "sk-" + it["id"].str }) { x ->
                        val id = x["id"].str.orEmpty()
                        val on = m.open == id
                        Pressable({ m.openSkill(app, id) }, Modifier.fillMaxWidth(), fill = if (on) k.c.chip else Color.Transparent) {
                            Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(x["name"].str.orEmpty(), style = k.ty.uiMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(firstLine(x["description"].str.orEmpty(), 90), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                val x = m.skill
                when {
                    x != null -> SkillDetail(app, x)
                    m.open != null -> PageLoading()
                }
            }
        }
    }
}

@Composable
private fun SkillDetail(app: AppModel, x: JsonElement) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Column(Modifier.widthIn(max = 900.dp).fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(x["name"].str.orEmpty(), style = k.ty.bodyMedium, color = k.c.fg)
                Pill(x["source"].str.orEmpty(), k.c.muted, k.c.chip)
                Spacer(Modifier.weight(1f))
                val cmd = "/" + x["name"].str.orEmpty()
                KButton("Copy command", {
                    scope.launch {
                        clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("command", cmd)))
                        app.say("✓ Copied $cmd")
                    }
                }, variant = Variant.OUTLINE, size = Size.SMALL, icon = Lucide.Copy)
            }
            SelectionContainer { Text(x["file"].str.orEmpty(), style = k.ty.textXsmall, color = k.c.faint) }
            Text(x["description"].str.orEmpty(), style = k.ty.ui, color = k.c.muted)
            skillMeta(x["meta"]).takeIf { it.isNotEmpty() }?.let { Text(it, style = k.ty.textXsmall, color = k.c.faint) }
            x["body"].text?.let { PageMarkdown(app, it, selectable = true) }
        }
    }
}
