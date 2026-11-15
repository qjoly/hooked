package dev.qjoly.hooked.ui.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.GITHUB_TABS
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.ghCheckTone
import dev.qjoly.hooked.data.ghItems
import dev.qjoly.hooked.data.ghMetaLine
import dev.qjoly.hooked.data.ghPeekable
import dev.qjoly.hooked.data.ghRepos
import dev.qjoly.hooked.data.ghRowDecision
import dev.qjoly.hooked.data.ghTitle
import dev.qjoly.hooked.data.githubOverview
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.markNotificationsDone
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.withoutNotifications
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIconButton
import dev.qjoly.hooked.ui.kit.KMenu
import dev.qjoly.hooked.ui.kit.KMenuItem
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.session.DockModel
import dev.qjoly.hooked.ui.session.DockOverlays
import dev.qjoly.hooked.ui.session.GhDetailPanel
import dev.qjoly.hooked.ui.session.Hint
import dev.qjoly.hooked.ui.session.copyText
import dev.qjoly.hooked.ui.session.leftRule
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** The page's own detail slot: a DockModel apart from the session dock's, as rune keeps `gh_page_view`. */
private const val PAGE_DOCK = "github-page"

/** Under this list width the side panel covers the list instead of sitting beside it. */
private val MIN_LIST_W = 360.dp

class GithubModel : PageModel() {
    /** The overview; JsonNull after a failed first load, so the page shows empty lists. */
    var overview by mutableStateOf<JsonElement?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var marking by mutableStateOf(false)
        private set
    var tab by mutableIntStateOf(0)
    var query by mutableStateOf("")
    var repo by mutableStateOf<String?>(null)

    /** Entering the page refetches, as rune's `go(Page::GitHub)` drops the overview. */
    fun load(app: AppModel, refresh: Boolean) {
        val c = app.client ?: return
        if (loading) return
        loading = true
        viewModelScope.launch {
            try {
                overview = c.githubOverview(refresh)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (overview == null) overview = JsonNull
                app.say("✗ GitHub: ${e.message}")
            } finally {
                loading = false
            }
        }
    }

    fun toggleRepo(r: String) {
        repo = if (repo == r) null else r
    }

    /** Marks the notifications shown as done; the ones GitHub accepted leave the list. */
    fun markDone(app: AppModel, ids: List<String>) {
        if (ids.isEmpty() || marking) return
        marking = true
        call(app, "Notifications") { c ->
            try {
                val r = c.markNotificationsDone(ids)
                overview = withoutNotifications(overview, r.done)
                app.say(r.error?.let { "✗ Some notifications stayed: $it" } ?: "✓ ${r.done.size} marked done")
            } finally {
                marking = false
            }
        }
    }
}

/** rune's GitHub page: five lists with counts, a filter and repo chips, and a pull request or issue beside. */
@Composable
fun GithubPage(app: AppModel) {
    val m: GithubModel = viewModel()
    val dock: DockModel = viewModel(key = PAGE_DOCK)
    val client = app.client
    LaunchedEffect(client) { client?.let(dock::bind) }
    LaunchedEffect(Unit) { m.load(app, refresh = false) }
    // The Actions run window a check link opens.
    DockOverlays(app, dock, PAGE_DOCK)
    PageFrame("GitHub", actions = {
        KButton("Refresh", { m.load(app, refresh = true) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, icon = Lucide.Restart, enabled = !m.loading)
    }) {
        val v = m.overview
        if (v == null) PageLoading() else GithubBody(app, m, dock, v)
    }
}

@Composable
private fun GithubBody(app: AppModel, m: GithubModel, dock: DockModel, v: JsonElement) {
    val c = k.c
    val view = dock.ghView
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val asideW = (maxWidth * 0.45f).coerceIn(420.dp, 720.dp).coerceAtMost(maxWidth)
        val beside = maxWidth - asideW >= MIN_LIST_W
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxHeight()) { GithubList(app, m, dock, v) }
            if (view != null && beside) {
                Column(Modifier.width(asideW).fillMaxHeight().background(c.bg).leftRule(c.border)) { Aside(app, dock) }
            }
        }
        if (view != null && !beside) {
            // Covers the list; the empty tap target keeps touches from reaching the rows below.
            Column(Modifier.fillMaxSize().background(c.bg).clickable(remember { MutableInteractionSource() }, indication = null) {}) { Aside(app, dock) }
        }
    }
}

@Composable
private fun Aside(app: AppModel, dock: DockModel) {
    val view = dock.ghView ?: return
    GhDetailPanel(app, dock, PAGE_DOCK, view, Modifier.fillMaxSize()) {
        KIconButton(Lucide.Close, "Close", { dock.closeGhFull() }, size = Size.SMALL)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GithubList(app: AppModel, m: GithubModel, dock: DockModel, v: JsonElement) {
    val c = k.c
    val counts = GITHUB_TABS.map { (key, _) -> ghItems(v, key, m.query, m.repo).size }
    val tab = m.tab.coerceIn(0, GITHUB_TABS.lastIndex)
    val key = GITHUB_TABS[tab].first
    val items = remember(v, key, m.query, m.repo) { ghItems(v, key, m.query, m.repo) }
    val repos = remember(v) { ghRepos(v).take(16) }
    val selected = dock.ghView?.url
    val item = Modifier.widthIn(max = 1052.dp).fillMaxWidth()
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(24.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item(key = "tabs") {
            Row(item.horizontalScroll(rememberScrollState()).padding(bottom = 4.dp)) {
                PageSegmented(GITHUB_TABS.mapIndexed { i, (_, label) -> "$label · ${counts[i]}" }, tab, { m.tab = it })
            }
        }
        item(key = "rail") {
            FlowRow(
                item.padding(bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                KTextInput(m.query, { m.query = it }, "Filter by title or repo, org/ to scope…", Modifier.width(320.dp))
                for (r in repos) RepoChip(r.repo, r.count, m.repo == r.repo) { m.toggleRepo(r.repo) }
            }
        }
        if (key == "notifications" && items.isNotEmpty()) {
            item(key = "mark") {
                Row(item.padding(bottom = 4.dp)) {
                    KButton(
                        "Mark the ${items.size} shown as done",
                        { m.markDone(app, items.mapNotNull { it["id"].str }) },
                        variant = Variant.OUTLINE,
                        size = Size.SMALL,
                        icon = Lucide.CircleCheck,
                        enabled = !m.marking,
                    )
                }
            }
        }
        if (items.isEmpty()) {
            item(key = "empty") { Text("Nothing here.", style = k.ty.body, color = c.faint, modifier = item) }
        }
        itemsIndexed(items, key = { i, x -> "$key-$i-${x["url"].str}" }) { _, x ->
            val url = x["url"].str.orEmpty()
            GhRow(app, x, url == selected, item) { if (ghPeekable(url)) dock.peekGh(url) else openOutside(app, it, url) }
        }
    }
}

private fun openOutside(app: AppModel, uri: androidx.compose.ui.platform.UriHandler, url: String) {
    if (runCatching { uri.openUri(url) }.isFailure) app.say("✗ Could not open $url")
}

/** A repo filter chip: the short name and its count; long press names the full repo. */
@Composable
private fun RepoChip(repo: String, n: Int, on: Boolean, onClick: () -> Unit) {
    val c = k.c
    val shape = RoundedCornerShape(k.r.sm)
    var hint by remember { mutableStateOf<String?>(null) }
    Pressable(
        onClick,
        Modifier.height(26.dp).border(1.dp, if (on) c.border2 else c.border, shape),
        onLongClick = { hint = repo },
        fill = if (on) c.chip else Color.Transparent,
        radius = k.r.sm,
    ) {
        Row(Modifier.padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(repo.substringAfterLast('/'), style = k.ty.textSmall, color = c.fg, maxLines = 1)
            Text(n.toString(), style = k.ty.textXsmall, color = c.faint, maxLines = 1)
        }
        Hint(hint) { hint = null }
    }
}

/** A long press stands in for rune's ⌘-click (browser) and hover help (the URL). */
@Composable
private fun GhRow(app: AppModel, x: JsonElement, selected: Boolean, modifier: Modifier, onOpen: (androidx.compose.ui.platform.UriHandler) -> Unit) {
    val c = k.c
    val uri = LocalUriHandler.current
    val ctx = LocalContext.current
    val url = x["url"].str.orEmpty()
    val shape = RoundedCornerShape(k.r.md)
    var menu by remember { mutableStateOf(false) }
    val dot = when (ghCheckTone(x["checks"].str)) {
        "ok" -> c.success.icon
        "ko" -> c.danger.icon
        "wait" -> c.warning.icon
        else -> c.faint
    }
    Box(modifier) {
        Pressable(
            { onOpen(uri) },
            Modifier.fillMaxWidth().border(1.dp, if (selected) c.accent else c.border, shape),
            onLongClick = { menu = true },
            fill = if (selected) c.chip else Color.Transparent,
            radius = k.r.md,
        ) {
            Row(
                Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(dot))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(ghTitle(x), style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(ghMetaLine(x, agoShort(x["updatedAt"].millis, app.now)), style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (x["draft"].bool) Pill("draft", c.muted, c.chip)
                ghRowDecision(x)?.let { (label, tone) ->
                    val ink = when (tone) {
                        "ok" -> c.success.fg
                        "ko" -> c.danger.fg
                        "muted" -> c.muted
                        else -> c.faint
                    }
                    Text(label, style = k.ty.textXsmallMedium, color = ink, maxLines = 1)
                }
                val add = x["additions"].int
                val del = x["deletions"].int
                if (add != null && del != null) {
                    Text("+$add", style = k.ty.textXsmall, color = c.success.fg, maxLines = 1)
                    Text("−$del", style = k.ty.textXsmall, color = c.danger.fg, maxLines = 1)
                }
            }
        }
        KMenu(menu, { menu = false }) {
            KMenuItem("Open on GitHub", { menu = false; openOutside(app, uri, url) }, icon = Lucide.Github, description = url)
            KMenuItem("Copy link", { menu = false; copyText(ctx, url); app.say("✓ Link copied") }, icon = Lucide.Copy)
        }
    }
}
