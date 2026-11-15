package dev.qjoly.hooked.ui

import dev.qjoly.hooked.ui.lens.LensHost
import dev.qjoly.hooked.ui.lens.LocalLensHost
import dev.qjoly.hooked.ui.session.DockHost
import dev.qjoly.hooked.ui.session.LocalDockHost
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.Lens
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.state.SessionUi
import dev.qjoly.hooked.state.of
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.lens.McpLens
import dev.qjoly.hooked.ui.lens.ReviewLens
import dev.qjoly.hooked.ui.lens.TraceLens
import dev.qjoly.hooked.ui.session.ContextDock
import dev.qjoly.hooked.ui.session.CostModal
import dev.qjoly.hooked.ui.session.ForkModal
import dev.qjoly.hooked.ui.session.GroupTabs
import dev.qjoly.hooked.ui.session.HeldSwitchModal
import dev.qjoly.hooked.ui.session.ImageViewer
import dev.qjoly.hooked.ui.session.LensTabs
import dev.qjoly.hooked.ui.session.MediaEnv
import dev.qjoly.hooked.ui.session.NewInGroupModal
import dev.qjoly.hooked.ui.session.PaneModal
import dev.qjoly.hooked.ui.session.SessionHeader
import dev.qjoly.hooked.ui.session.SplitPane
import dev.qjoly.hooked.ui.session.TerminalDrawer
import dev.qjoly.hooked.ui.session.edge
import dev.qjoly.hooked.ui.session.splitWithRecent
import kotlinx.coroutines.delay

/** The current time, ticking so ages and countdowns stay right. */
@Composable
fun rememberNow(periodMs: Long = 30_000): Long {
    val now by produceState(System.currentTimeMillis(), periodMs) {
        while (true) {
            delay(periodMs)
            value = System.currentTimeMillis()
        }
    }
    return now
}

/** rune's right column width, and the pane width under which it folds away. */
private val DOCK_W = 300.dp
private val DOCK_MIN_PANE = 820.dp

/** session.rs `view`: header, group tabs, lenses, the lens, the terminal drawer; the dock or the splits beside. */
@Composable
fun SessionPane(app: AppModel, id: String, onBack: (() -> Unit)?) {
    val client = app.client ?: return
    val ctx = LocalContext.current
    val ui = remember { SessionUi.of(ctx) }
    if (app.prefs.incognito && !app.meta.of(id).incognito) {
        // Incognito hides every session not flagged for it, this pane included.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Hidden in incognito mode.", style = k.ty.body, color = k.c.faint) }
        return
    }
    val model = remember(id, client) { SessionModel(id, client) }
    DisposableEffect(model) {
        model.say = app::say
        onDispose { model.close() }
    }
    LifecycleStartEffect(model) {
        model.start()
        onStopOrDispose { model.stop() }
    }
    LaunchedEffect(model, app.session(id)?.changeKey) { model.load() }
    LaunchedEffect(model.actionError) {
        model.actionError?.let {
            app.say("✗ $it")
            model.actionError = null
        }
    }
    var modal by remember(id) { mutableStateOf<PaneModal?>(null) }
    val open = { m: PaneModal -> modal = m }
    val toolsOpen = remember(id) { mutableStateMapOf<String, Boolean>() }
    val media = remember(id, client) { MediaEnv(client, id) { paths, i, pasted -> modal = PaneModal.Image(paths, i, pasted) } }
    val env = remember(model) { ConverseEnv(app, model, ui, media, toolsOpen, ctx) { modal = PaneModal.Fork(it) } }
    // Splits never show the main session twice.
    LaunchedEffect(id) { ui.splits.remove(id) }

    BoxWithConstraints(
        Modifier.fillMaxSize().onPreviewKeyEvent { e ->
            // Ctrl or ⌘ with a lens key, so the composer keeps plain digits.
            if (e.type != KeyEventType.KeyDown || !(e.isCtrlPressed || e.isMetaPressed)) return@onPreviewKeyEvent false
            when (e.key) {
                Key.One -> ui.lens = Lens.CONVERSE
                Key.Two -> ui.termOpen = !ui.termOpen
                Key.Three -> ui.lens = Lens.REVIEW
                Key.Four -> ui.lens = Lens.MCP
                Key.Five -> ui.lens = Lens.TRACE
                else -> return@onPreviewKeyEvent false
            }
            true
        },
    ) {
        val dockFits = maxWidth >= DOCK_MIN_PANE
        Row(Modifier.fillMaxSize()) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                val d = model.detail
                if (d == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(model.loadError ?: "Loading…", style = k.ty.body, color = k.c.faint)
                    }
                    return@Column
                }
                SessionHeader(app, model, ui, onBack ?: app::openDeck, {
                    if (ui.splits.isNotEmpty()) ui.splits.clear() else splitWithRecent(app, ui, id)
                }, open)
                GroupTabs(app, id, open)
                LensTabs(ui, model.conversation?.turns?.size ?: 0, model.conversation?.changes ?: 0)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (ui.lens) {
                        Lens.CONVERSE -> Converse(env, ui)
                        Lens.REVIEW -> CompositionLocalProvider(LocalLensHost provides LensHost { ui.lens = Lens.CONVERSE }) {
                            ReviewLens(app, model, Modifier.fillMaxSize())
                        }
                        Lens.MCP -> McpLens(app, model, Modifier.fillMaxSize())
                        Lens.TRACE -> TraceLens(app, model, Modifier.fillMaxSize())
                    }
                }
                TerminalDrawer(app, ui, id, d.session.project, if (ui.termOpen) Modifier.weight(0.8f) else Modifier)
            }
            if (!ui.focus) {
                if (ui.splits.isNotEmpty()) {
                    val one = ui.splits.size == 1
                    ui.splits.toList().forEach { s ->
                        SplitPane(app, ui, s, id, if (one) Modifier.fillMaxWidth(0.42f) else Modifier.weight(1f), open)
                    }
                } else if (ui.dockOpen && ui.lens == Lens.CONVERSE && dockFits && model.detail != null) {
                    // The dock paints its own rule and collapses when it has nothing to show.
                    CompositionLocalProvider(LocalDockHost provides DockHost { ui.lens = Lens.REVIEW }) {
                        ContextDock(app, model, Modifier.width(DOCK_W))
                    }
                }
            }
        }
    }

    when (val m = modal) {
        null -> {}
        PaneModal.Cost -> CostModal(model) { modal = null }
        is PaneModal.Fork -> ForkModal(app, model, m.uuid) { modal = null }
        is PaneModal.NewInGroup -> NewInGroupModal(app, m.mother) { modal = null }
        is PaneModal.Image -> ImageViewer(media, m.paths, m.index, m.pasted) { modal = null }
        is PaneModal.Organize -> SidebarModals(app, m.m) { modal = null }
    }
    HeldSwitchModal(model)
}

@Composable
private fun Converse(env: ConverseEnv, ui: SessionUi) {
    val model = env.model
    val d = model.detail ?: return
    val conv = model.conversation ?: return
    Column(Modifier.fillMaxSize()) {
        ConverseTranscript(env, conv, d, Modifier.weight(1f))
        PendingCards(model)
        Composer(model, ui)
    }
}
