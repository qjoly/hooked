package dev.qjoly.hooked.ui.lens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.lens.Annotation
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.panel
import dev.qjoly.hooked.ui.pages.PageMarkdown
import dev.qjoly.hooked.ui.pages.PageTextArea

// The widgets the Review lens shows under diff lines (view/lenses.rs `annotation` and `def_card`).

@Composable
fun ReviewAnnotation(app: AppModel, r: ReviewModel, a: Annotation) {
    when (a.id) {
        "def" -> DefCard(r)
        "draft" -> DraftCard(r)
        else -> ThreadCard(app, r, a.id)
    }
}

@Composable
private fun Shell(maxW: Dp = 720.dp, border: Color = k.c.border, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.widthIn(max = maxW).fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).panel(k.c.surface, border, k.r.md).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

@Composable
private fun Actions(content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) { content() }
}

@Composable
private fun DraftCard(r: ReviewModel) {
    val d = r.draft ?: return
    Shell {
        PageTextArea(d.text, { r.draft = d.copy(text = it) }, placeholder = "Comment on these lines…", minRows = 2, maxRows = 10)
        Actions {
            KButton("Cancel", r::cancelComment, variant = Variant.GHOST_MUTED, size = Size.SMALL)
            KButton("Comment", r::saveComment, variant = Variant.CONTRAST, size = Size.SMALL)
        }
    }
}

@Composable
private fun ThreadCard(app: AppModel, r: ReviewModel, tid: String) {
    val t = r.threads.firstOrNull { it.id == tid } ?: return
    val (status, color) = when {
        t.archived -> "archived" to k.c.faint
        t.sent -> "sent" to k.c.info.fg
        else -> "pending · not sent yet" to k.c.warning.fg
    }
    Shell {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(status, style = k.ty.textXsmallMedium, color = color)
            Spacer(Modifier.weight(1f))
            if (!t.sent && !t.archived) KButton("Edit", { r.startEditThread(tid) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
            KButton(if (t.archived) "Reopen" else "Archive", { r.archiveThread(tid, !t.archived) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
            KButton("Delete", { r.deleteThread(tid) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
        }
        if (t.archived) return@Shell
        val editing = r.editing?.takeIf { it.first == tid }
        if (editing != null) {
            PageTextArea(editing.second, { r.editing = tid to it }, minRows = 2, maxRows = 10)
            Actions {
                KButton("Cancel", { r.editing = null }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
                KButton("Save", r::saveEditThread, variant = Variant.CONTRAST, size = Size.SMALL)
            }
            return@Shell
        }
        for (m in t.messages) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (m.author == "claude") "Claude" else "You", style = k.ty.textXsmallMedium, color = k.c.faint)
                PageMarkdown(app, m.text, selectable = true)
            }
        }
        if (t.sent) {
            KTextInput(r.replies[tid].orEmpty(), { r.setReply(tid, it) }, "Reply…", Modifier.fillMaxWidth(), onSubmit = { r.replyThread(tid) })
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DefCard(r: ReviewModel) {
    val d = r.def ?: return
    val s = d.state
    val title = when {
        s is DefState.Choose || d.symbol == null -> "Go to definition of…"
        s is DefState.Items && s.refsOnly -> "References to ${d.symbol}"
        s is DefState.Items -> "${s.items.size} possible declarations of ${d.symbol}"
        else -> "Definition of ${d.symbol}"
    }
    @Composable
    fun note(msg: String) = Text(msg, style = k.ty.textSmall, color = k.c.faint)
    Shell(maxW = 820.dp, border = k.c.accent) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            KIcon(Lucide.Code, k.c.muted, 13.dp)
            Text(title, style = k.ty.textSmallMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (d.choices.size > 1 && s !is DefState.Choose) KButton("Other name", r::defBack, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.ArrowLeft)
            KIconButton(Lucide.Close, "Close", r::closeDef, variant = Variant.GHOST_MUTED, size = Size.SMALL)
        }
        when (s) {
            DefState.Choose -> if (d.choices.isEmpty()) {
                note("No name on this line to look up.")
            } else {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (w in d.choices) {
                        Pressable({ r.defLookup(w) }, Modifier.height(24.dp).border(1.dp, k.c.border, RoundedCornerShape(k.r.sm)), radius = k.r.sm) {
                            Text(w, style = k.ty.mono, color = k.c.fg, modifier = Modifier.padding(horizontal = 8.dp))
                        }
                    }
                }
            }
            DefState.Loading -> note("Looking up ${d.symbol.orEmpty()}…")
            is DefState.Note -> note(s.msg)
            is DefState.Items -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                for (item in s.items) {
                    Pressable({ r.defPick(item) }, Modifier.fillMaxWidth(), radius = k.r.sm) {
                        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("${item["rel"].str.orEmpty()}:${item["line"].int ?: 0}", style = k.ty.textXsmallMedium, color = k.c.accent, maxLines = 1)
                                Text(item["reason"].str ?: item["kind"].str.orEmpty(), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Text(item["text"].str.orEmpty().trim(), style = k.ty.mono, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            is DefState.Source -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val at = s.target["line"].int ?: 0
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${s.target["rel"].str.orEmpty()}:$at", style = k.ty.textXsmallMedium, color = k.c.accent)
                    Text(s.target["kind"].str.orEmpty(), style = k.ty.textXsmall, color = k.c.faint)
                }
                val data = s.data
                when {
                    s.err != null -> note(s.err)
                    data == null -> note("Loading the file…")
                    else -> {
                        val from = data["from"].int ?: 1
                        val total = data["total"].int ?: 0
                        val lines = data["lines"].arr
                        if (from > 1) KButton("Earlier lines", { r.defExpand(true) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
                        Column(
                            Modifier.fillMaxWidth().panel(k.c.bg, k.c.border, k.r.sm).horizontalScroll(rememberScrollState()).padding(vertical = 4.dp),
                        ) {
                            lines.forEachIndexed { i, l ->
                                val n = from + i
                                val here = n == at
                                Row(
                                    Modifier.background(if (here) k.c.warning.bg else Color.Transparent).padding(horizontal = 8.dp),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Text("$n", style = k.ty.mono, color = k.c.faint, modifier = Modifier.width(36.dp), maxLines = 1)
                                    Text(l.str.orEmpty(), style = k.ty.mono, color = if (here) k.c.fg else k.c.muted, maxLines = 1, softWrap = false)
                                }
                            }
                        }
                        if (from + lines.size <= total) KButton("Later lines", { r.defExpand(false) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
                    }
                }
            }
        }
    }
}
