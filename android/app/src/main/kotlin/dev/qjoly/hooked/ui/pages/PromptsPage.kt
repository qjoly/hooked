package dev.qjoly.hooked.ui.pages

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.SavedPrompt
import dev.qjoly.hooked.data.firstLine
import dev.qjoly.hooked.data.promptLibrary
import dev.qjoly.hooked.data.promptLibraryJson
import dev.qjoly.hooked.data.saveSetting
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k

/** The prompt being edited: an index into the library, or null for a new one. */
data class PromptSel(val index: Int?)

class PromptsModel : PageModel() {
    /** The library as last saved here; null until the server settings are read. */
    var list by mutableStateOf<List<SavedPrompt>?>(null)
        private set
    var sel by mutableStateOf<PromptSel?>(null)
    var name by mutableStateOf("")
    var text by mutableStateOf("")

    fun enter(app: AppModel) {
        if (list == null) list = promptLibrary(app.settings)
        call(app, "Settings") { list = promptLibrary(it.get("api/settings")) }
    }

    fun edit(index: Int?) {
        val p = index?.let { list?.getOrNull(it) }
        sel = PromptSel(index)
        name = p?.name.orEmpty()
        text = p?.text.orEmpty()
    }

    fun save(app: AppModel) {
        val s = sel ?: return
        val n = name.trim()
        val t = text.trim()
        if (n.isEmpty() || t.isEmpty()) {
            app.say("✗ A prompt needs a name and a text")
            return
        }
        val next = list.orEmpty().toMutableList()
        val entry = SavedPrompt(n, t)
        val i = s.index
        if (i != null && i < next.size) {
            next[i] = entry
        } else {
            next += entry
            sel = PromptSel(next.size - 1)
        }
        persist(app, next)
    }

    fun delete(app: AppModel) {
        val i = sel?.index ?: return
        val next = list.orEmpty().toMutableList()
        if (i < next.size) next.removeAt(i)
        sel = null
        persist(app, next)
    }

    private fun persist(app: AppModel, next: List<SavedPrompt>) {
        list = next
        call(app, "Settings") { it.saveSetting("promptLibrary", promptLibraryJson(next)) }
    }
}

/** rune's Prompts page: the saved prompts the New session page offers, with an editor. */
@Composable
fun PromptsPage(app: AppModel) {
    val m: PromptsModel = viewModel()
    LaunchedEffect(Unit) { m.enter(app) }
    val list = m.list.orEmpty()
    PageFrame("Prompts · ${list.size}") {
        Row(Modifier.fillMaxSize()) {
            Column(Modifier.sideList(300.dp, k.c.border).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                KButton("New prompt", { m.edit(null) }, variant = Variant.CONTRAST, size = Size.REGULAR, icon = Lucide.Plus)
                LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (list.isEmpty()) {
                        item {
                            Text(
                                "No prompt yet. Saved prompts show up on the New session page, ready to drop into the draft.",
                                style = k.ty.textSmall, color = k.c.faint,
                            )
                        }
                    }
                    itemsIndexed(list) { i, p ->
                        val on = m.sel?.index == i
                        Pressable({ m.edit(i) }, Modifier.fillMaxWidth(), radius = k.r.sm, fill = if (on) k.c.chip else Color.Transparent) {
                            Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(p.name, style = k.ty.uiMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(firstLine(p.text, 80), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                val s = m.sel
                if (s == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Pick a prompt to edit it, or create one.", style = k.ty.body, color = k.c.faint)
                    }
                } else {
                    PromptEditor(app, m, s)
                }
            }
        }
    }
}

@Composable
private fun PromptEditor(app: AppModel, m: PromptsModel, s: PromptSel) {
    val focus = remember { FocusRequester() }
    // rune focuses the name on every pick; here only for a new prompt, so the keyboard does not pop on a tap.
    LaunchedEffect(s) { if (s.index == null) runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        KTextInput(m.name, { m.name = it }, "Name", Modifier.fillMaxWidth().focusRequester(focus))
        PageTextArea(m.text, { m.text = it }, "The prompt…", minRows = 8, maxRows = 30)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KButton("Save", { m.save(app) }, variant = Variant.CONTRAST, size = Size.REGULAR)
            KButton("Cancel", { m.sel = null }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
            if (s.index != null) {
                Spacer(Modifier.weight(1f))
                KButton("Delete", { m.delete(app) }, variant = Variant.DANGER, size = Size.REGULAR)
            }
        }
    }
}
