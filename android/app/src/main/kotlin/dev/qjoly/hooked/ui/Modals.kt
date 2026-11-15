package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.groupLabel
import dev.qjoly.hooked.state.isArchived
import dev.qjoly.hooked.state.of
import dev.qjoly.hooked.state.parseTags
import dev.qjoly.hooked.state.projectLabel
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.kit.tagIndex

/** rune's modal: a scrim, and a 520 panel 120 from the top, padding 16, gap 12. */
@Composable
fun KModal(onDismiss: () -> Unit, title: String, width: Dp = 520.dp, content: @Composable ColumnScope.() -> Unit) {
    val kit = k
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        ProvideKit(kit) {
            Box(
                Modifier.fillMaxSize().clickable(remember { MutableInteractionSource() }, indication = null, onClick = onDismiss).imePadding(),
                contentAlignment = Alignment.TopCenter,
            ) {
                val shape = RoundedCornerShape(k.r.lg)
                Column(
                    Modifier.padding(top = 120.dp).width(width)
                        .shadow(16.dp, shape, ambientColor = k.c.shadow, spotColor = k.c.shadow)
                        .clip(shape).background(k.c.bg).border(1.dp, k.c.border, shape)
                        .clickable(remember { MutableInteractionSource() }, indication = null) {}
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(title, style = k.ty.uiMedium, color = k.c.fg)
                    content()
                }
            }
        }
    }
}

@Composable
fun SidebarModals(app: AppModel, modal: SidebarModal, close: () -> Unit) {
    when (modal) {
        is SidebarModal.Filter -> FilterPicker(app, modal.tags, close)
        is SidebarModal.Tags -> TagsModal(app, modal.id, close)
        is SidebarModal.Group -> GroupPicker(app, modal.id, close)
        is SidebarModal.RenameGroup -> RenameGroup(app, modal.id, close)
    }
}

/** Repo filter is any-of, tag filter all-of; picked first, then by count, then A→Z. */
@Composable
private fun FilterPicker(app: AppModel, tags: Boolean, close: () -> Unit) {
    val c = k.c
    var q by remember { mutableStateOf("") }
    val counts = mutableMapOf<String, Int>()
    for (s in app.visible) {
        if (app.prefs.sidebarLayout != "status" && isArchived(s, app.meta, app.now) != SidebarState.showArchived) continue
        if (tags) app.tagsOf(s.id).forEach { counts[it] = (counts[it] ?: 0) + 1 } else projectLabel(s).let { counts[it] = (counts[it] ?: 0) + 1 }
    }
    val picked = if (tags) app.tagFilter else app.repoFilter
    picked.forEach { counts.putIfAbsent(it, 0) }
    val needle = q.trim().trimStart('#').lowercase()
    val options = counts.keys.filter { needle.isEmpty() || needle in it.lowercase() }
        .sortedWith(compareBy<String>({ it !in picked }, { if (tags) 0 else -(counts[it] ?: 0) }, { it.lowercase() }))
    fun toggle(v: String) {
        if (tags) app.tagFilter = if (v in app.tagFilter) app.tagFilter - v else app.tagFilter + v
        else app.repoFilter = if (v in app.repoFilter) app.repoFilter - v else app.repoFilter + v
    }
    KModal(close, if (tags) "Filter by tag · all of" else "Filter by repo · any of") {
        KTextInput(q, { q = it }, if (tags) "Search tags… (Enter picks the first)" else "Search repos… (Enter picks the first)", Modifier.fillMaxWidth(), onSubmit = { options.firstOrNull()?.let(::toggle) })
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (o in options) {
                val on = o in picked
                Pressable({ toggle(o) }, Modifier.fillMaxWidth().height(32.dp), radius = k.r.md) {
                    Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        KIcon(if (on) Lucide.CircleCheck else Lucide.Circle, if (on) c.accent else c.faint, 14.dp)
                        Text(
                            if (tags) "#$o" else o, style = k.ty.ui,
                            color = if (tags) c.tagHue(tagIndex(o, app.prefs.tagColors)) else c.fg,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        )
                        Text("${counts[o] ?: 0}", style = k.ty.textXsmall, color = c.faint)
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { KButton("Done", close, variant = Variant.CONTRAST) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagsModal(app: AppModel, id: String, close: () -> Unit) {
    val c = k.c
    val s = app.session(id) ?: return close()
    var text by remember { mutableStateOf(app.tagsOf(id).joinToString(" ")) }
    val all = app.active.flatMap { app.tagsOf(it.id) }.distinct().sorted()
    val current = parseTags(text)
    fun save() {
        app.setTags(id, parseTags(text))
        close()
    }
    KModal(close, "Edit tags") {
        Text(app.title(s), style = k.ty.textSmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        KTextInput(text, { text = it }, "Tags, separated by spaces or commas", Modifier.fillMaxWidth(), onSubmit = ::save)
        if (all.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (t in all) {
                    val on = t in current
                    val shape = RoundedCornerShape(12.dp)
                    Box(
                        Modifier.height(24.dp).clip(shape).background(if (on) c.border else Color.Transparent)
                            .border(1.dp, if (on) c.border2 else c.border, shape)
                            .clickable { text = (if (on) current - t else current + t).joinToString(" ") }
                            .padding(horizontal = 9.dp),
                        contentAlignment = Alignment.Center,
                    ) { Text("#$t", style = k.ty.textSmall, color = c.tagHue(tagIndex(t, app.prefs.tagColors))) }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            KButton("Cancel", close, variant = Variant.GHOST_MUTED)
            KButton("Save", ::save, variant = Variant.CONTRAST)
        }
    }
}

/** Up to 12 group leads to join, matched on their label and project. */
@Composable
private fun GroupPicker(app: AppModel, id: String, close: () -> Unit) {
    val c = k.c
    var q by remember { mutableStateOf("") }
    val leads = app.active.filter { it.id != id }
        .map { s -> app.meta.of(s.id).groupOf?.let(app::session) ?: s }
        .distinctBy { it.id }
        .filter { it.id != id }
        .filter { lead -> q.isBlank() || "${groupLabel(lead, app.meta, app.prefs.names)} ${projectLabel(lead)}".lowercase().contains(q.trim().lowercase()) }
        .take(12)
    KModal(close, "Move to group") {
        KTextInput(q, { q = it }, "Join the group of…", Modifier.fillMaxWidth())
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (lead in leads) {
                val members = 1 + app.sessions.count { app.meta.of(it.id).groupOf == lead.id && it.id != lead.id }
                Pressable({ app.groupOp("join", id, target = lead.id); close() }, Modifier.fillMaxWidth().height(34.dp), radius = k.r.md) {
                    Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Dot(c.stateColor(lead.state.name.lowercase()), 7.dp)
                        Text(groupLabel(lead, app.meta, app.prefs.names), style = k.ty.ui, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(if (members > 1) "group of $members" else projectLabel(lead), style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                    }
                }
            }
            if (leads.isEmpty()) Text("No session matches.", style = k.ty.ui, color = c.faint)
        }
    }
}

@Composable
private fun RenameGroup(app: AppModel, id: String, close: () -> Unit) {
    var name by remember { mutableStateOf(app.meta.of(id).groupName.orEmpty()) }
    fun save() {
        app.groupOp("rename", id, name = name.trim())
        close()
    }
    KModal(close, "Rename the group") {
        KTextInput(name, { name = it }, "Group name (empty restores the lead session's title)", Modifier.fillMaxWidth(), onSubmit = ::save)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            KButton("Cancel", close, variant = Variant.GHOST_MUTED)
            KButton("Rename", ::save, variant = Variant.CONTRAST)
        }
        Spacer(Modifier.height(0.dp))
    }
}
