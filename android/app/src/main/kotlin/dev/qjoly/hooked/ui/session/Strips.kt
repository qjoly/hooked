package dev.qjoly.hooked.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.Lens
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.groupLabel
import dev.qjoly.hooked.state.groupMembers
import dev.qjoly.hooked.state.of
import dev.qjoly.hooked.ui.SidebarModal
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.terminal.TerminalDock

/** A hairline on one edge, as rune's `border_sides`. */
fun Modifier.edge(color: Color, top: Boolean = false, bottom: Boolean = false, start: Boolean = false, width: Dp = 1.dp) = drawBehind {
    val w = width.toPx()
    if (start) drawRect(color, Offset.Zero, androidx.compose.ui.geometry.Size(w, size.height))
    if (top) drawRect(color, Offset.Zero, androidx.compose.ui.geometry.Size(size.width, w))
    if (bottom) drawRect(color, Offset(0f, size.height - w), androidx.compose.ui.geometry.Size(size.width, w))
}

/** session.rs `group_tabs`: the group's members as tabs, with lead, leave and a new session. */
@Composable
fun GroupTabs(app: AppModel, id: String, open: (PaneModal) -> Unit) {
    val c = k.c
    val mother = app.meta.of(id).groupOf?.takeIf { app.session(it) != null } ?: id
    val members = groupMembers(mother, app.sessions, app.meta).filter { app.session(it) != null }
    if (members.size < 2) return
    val lead = app.session(mother) ?: return
    Row(
        Modifier.fillMaxWidth().height(34.dp).edge(c.border, bottom = true).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            Modifier.clip(RoundedCornerShape(k.r.sm)).clickable { open(PaneModal.Organize(SidebarModal.RenameGroup(mother))) }.padding(end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            KIcon(Lucide.List, c.muted, 12.dp)
            Text(groupLabel(lead, app.meta, app.prefs.names), style = k.ty.textSmallMedium, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
        }
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            members.forEach { m ->
                val x = app.session(m) ?: return@forEach
                val on = m == id
                val isLead = m == mother
                Row(
                    Modifier.height(26.dp).widthIn(max = 240.dp).clip(RoundedCornerShape(k.r.sm)).background(if (on) c.chip else Color.Transparent)
                        .padding(start = 8.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Row(
                        Modifier.weight(1f, fill = false).clickable { app.open(m) },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Dot(c.stateColor(stateKey(x.state)), 7.dp)
                        if (isLead) KIcon(Lucide.Star, c.accent, 11.dp)
                        Text(app.title(x), style = k.ty.textSmall, color = if (on) c.fg else c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (!isLead) KIconButton(Lucide.Star, "Make it the lead session", { app.groupOp("mother", m) }, size = Size.SMALL)
                    KIconButton(Lucide.Close, "Remove from the group", { app.groupOp("leave", m) }, size = Size.SMALL)
                }
            }
        }
        KIconButton(Lucide.Plus, "New session in this group", { open(PaneModal.NewInGroup(mother)) }, size = Size.SMALL)
    }
}

/** session.rs `lenses`: Converse, Review, MCP, Trace, each with its count and key. */
@Composable
fun LensTabs(ui: SessionUi, converse: Int, review: Int) {
    val c = k.c
    Row(
        Modifier.fillMaxWidth().edge(c.border, bottom = true).padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        LensTab(ui, Lens.CONVERSE, Lucide.Converse, "Converse", converse)
        LensTab(ui, Lens.REVIEW, Lucide.Ship, "Review", review)
        LensTab(ui, Lens.MCP, Lucide.Plug, "MCP", 0)
        LensTab(ui, Lens.TRACE, Lucide.Activity, "Trace", 0)
    }
}

@Composable
private fun LensTab(ui: SessionUi, lens: Lens, icon: ImageVector, label: String, count: Int) {
    val c = k.c
    val on = ui.lens == lens
    Row(
        Modifier.height(32.dp).clickable { ui.lens = lens }.edge(if (on) c.accent else Color.Transparent, bottom = true, width = 2.dp).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        KIcon(icon, if (on) c.fg else c.muted, 14.dp)
        Text(label, style = k.ty.uiMedium, color = if (on) c.fg else c.muted)
        if (count > 0) Text("$count", style = k.ty.textXsmall, color = c.faint)
        Box(Modifier.height(16.dp).clip(RoundedCornerShape(3.dp)).border(1.dp, c.border, RoundedCornerShape(3.dp)).padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
            Text(lens.key, style = k.ty.textXsmall.copy(lineHeight = k.ty.textXsmall.fontSize), color = c.faint)
        }
    }
}

/** view/terminal.rs `panel`: a drawer bar while closed, the shells below the lens once open. */
@Composable
fun TerminalDrawer(app: AppModel, ui: SessionUi, id: String, project: String?, modifier: Modifier = Modifier) =
    TerminalDock(app, id, project, ui.termOpen, { ui.termOpen = it }, modifier)
