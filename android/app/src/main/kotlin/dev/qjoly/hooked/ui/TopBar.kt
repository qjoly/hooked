package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.Gauge
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.Page
import dev.qjoly.hooked.ui.kit.Appearance
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.FlashToast
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k

/** desktop's top bar: logo, tabs, the omni field, gauges, actions, "+ Session" and the connection dot. */
@Composable
fun TopBar(app: AppModel, wide: Boolean, onPalette: () -> Unit, onAccount: () -> Unit, onTrash: () -> Unit) {
    val c = k.c
    val line = c.border
    Row(
        Modifier.fillMaxWidth().height(52.dp).background(c.bg)
            .drawBehind { drawLine(line, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }
            .padding(start = 24.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Logo(app.active)
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Tab("Deck", Lucide.Deck, app.page == Page.Deck, wide) { app.openDeck() }
            val tabs = app.navTabs
            if (tabs?.contains("sessions") != false) Tab("Sessions", Lucide.List, app.page is Page.Session, wide) { app.openSessions() }
            listOf(
                Triple("stats", Page.Stats, "Stats" to Lucide.Chart),
                Triple("digest", Page.Digest, "Digest" to Lucide.Book),
                Triple("memory", Page.Memory, "Memory" to Lucide.Brain),
                Triple("cron", Page.Cron, "Cron" to Lucide.Timer),
                Triple("github", Page.Github, "GitHub" to Lucide.Github),
                Triple("skills", Page.Skills, "Skills" to Lucide.Sparkle),
                Triple("prompts", Page.Prompts, "Prompts" to Lucide.Book),
            ).forEach { (key, page, look) ->
                // A module switched off in Settings → Modules takes its tab away.
                if ((tabs == null || key in tabs || app.page == page) && (app.moduleOn(key) || app.page == page)) Tab(look.first, look.second, app.page == page, wide) { app.page = page }
            }
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { Omni(onPalette, wide) }
        // rune shows the flash beside the omni field, not over it.
        app.flash?.let { FlashToast(it, Modifier.weight(1f, fill = false)) }
        if (wide) Gauges(app.gauges)
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
            if (app.prefs.incognito) {
                KButton("Incognito", { app.toggleIncognitoMode() }, variant = Variant.WARNING, size = Size.SMALL, icon = Lucide.EyeOff)
            } else {
                KIconButton(Lucide.Eye, "Incognito mode", { app.toggleIncognitoMode() })
            }
            KIconButton(Lucide.User, "Claude account", onAccount)
            KIconButton(Lucide.Trash, "Trash", onTrash)
            KIconButton(if (app.notify) Lucide.Bell else Lucide.BellOff, if (app.notify) "Notifications: on" else "Notifications: off", { app.changeNotify(!app.notify) })
            val ap = app.prefs.appearance
            KIconButton(
                when (ap) {
                    Appearance.LIGHT -> Lucide.Sun
                    Appearance.DARK -> Lucide.Moon
                    Appearance.SYSTEM -> Lucide.Monitor
                },
                "Theme: ${ap.label.lowercase()}",
                {
                    app.prefs.appearance(
                        when (ap) {
                            Appearance.SYSTEM -> Appearance.LIGHT
                            Appearance.LIGHT -> Appearance.DARK
                            Appearance.DARK -> Appearance.SYSTEM
                        },
                    )
                },
            )
            KIconButton(Lucide.Gear, "Settings", { app.openSettings() }, variant = if (app.page == Page.Settings) Variant.NEUTRAL else Variant.GHOST_MUTED)
        }
        KButton("Session", { app.openNew() }, variant = Variant.CONTRAST, size = Size.REGULAR, icon = Lucide.Plus)
        Dot(if (app.connected) c.success.icon else c.danger.icon, 8.dp)
    }
}

@Composable
private fun Tab(label: String, icon: ImageVector, active: Boolean, wide: Boolean, onClick: () -> Unit) {
    val c = k.c
    Pressable(onClick, Modifier.height(28.dp), fill = if (active) c.chip else Color.Transparent, radius = k.r.md) {
        Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            KIcon(icon, if (active) c.fg else c.muted, 14.dp)
            if (wide) Text(label, style = k.ty.uiMedium, color = if (active) c.fg else c.muted)
        }
    }
}

@Composable
private fun Omni(onClick: () -> Unit, wide: Boolean) {
    val c = k.c
    val shape = RoundedCornerShape(k.r.md)
    Pressable(onClick, Modifier.widthIn(max = 380.dp).fillMaxWidth().height(30.dp).border(1.dp, c.border, shape), fill = c.surface, radius = k.r.md) {
        Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KIcon(Lucide.Search, c.muted, 14.dp)
            Text("Search, launch, command…", style = k.ty.ui, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (wide) Text("⌘K", style = k.ty.textXsmallMedium, color = c.faint)
        }
    }
}

/** The account rate limits: danger from 90 %, warning from 75 %, muted below. */
@Composable
private fun Gauges(gauges: List<Gauge>) {
    val c = k.c
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        for (g in gauges) {
            Column(Modifier.width(64.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(g.label, style = k.ty.textXsmallMedium, color = c.faint, maxLines = 1)
                    Text(g.pct?.let { "$it%" } ?: "—", style = k.ty.textXsmallMedium, color = c.muted)
                }
                val p = (g.pct ?: 0).coerceIn(0, 100)
                val fill = when {
                    p >= 90 -> c.danger.icon
                    p >= 75 -> c.warning.icon
                    else -> c.muted
                }
                Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(1.5.dp)).background(c.border)) {
                    Box(Modifier.width(64.dp * p / 100).height(3.dp).clip(RoundedCornerShape(1.5.dp)).background(fill))
                }
            }
        }
        Spacer(Modifier.size(0.dp))
    }
}

/** True when the window is at least `minWidth` wide. */
@Composable
fun Wide(minWidth: Int, content: @Composable (Boolean) -> Unit) = BoxWithConstraints { content(maxWidth >= minWidth.dp) }
