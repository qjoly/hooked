package dev.qjoly.hooked.ui.lens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.firstLine
import dev.qjoly.hooked.data.lens.TraceSpan
import dev.qjoly.hooked.data.lens.TraceTurn
import dev.qjoly.hooked.data.lens.clip
import dev.qjoly.hooked.data.lens.dur
import dev.qjoly.hooked.data.lens.spanBar
import dev.qjoly.hooked.data.lens.trace
import dev.qjoly.hooked.data.lens.traceCalls
import dev.qjoly.hooked.data.lens.traceTool
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Spinner
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The Trace lens of one session (lenses.rs `trace_*`): its tool calls, profiler style, grouped by turn. */
class TraceModel(private val id: String) : ViewModel() {
    var sig by mutableStateOf<String?>(null)
        private set
    var turns by mutableStateOf<List<TraceTurn>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var open by mutableStateOf<String?>(null)
        private set
    var tools by mutableStateOf<Map<String, Pair<String, String>>>(emptyMap())
        private set

    /** Reloads when the session moved on since the last read. */
    fun ensure(app: AppModel, activity: Long?) {
        val next = "$id|${activity ?: ""}"
        if (sig == next || loading) return
        val c = app.client ?: return
        loading = true
        viewModelScope.launch {
            try {
                turns = c.trace(id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.say("✗ Trace: ${e.message}")
            } finally {
                loading = false
                sig = next
            }
        }
    }

    fun toggle(app: AppModel, tool: String) {
        if (open == tool) {
            open = null
            return
        }
        open = tool
        if (tools.containsKey(tool)) return
        val c = app.client ?: return
        viewModelScope.launch {
            val v = try {
                c.traceTool(id, tool)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                "" to "✗ ${e.message}"
            }
            tools = tools + (tool to v)
        }
    }
}

/** rune's Trace lens. */
@Composable
fun TraceLens(app: AppModel, model: SessionModel, modifier: Modifier = Modifier) {
    val t: TraceModel = viewModel(key = "trace:${model.id}") { TraceModel(model.id) }
    val activity = model.detail?.session?.lastActivity
    LaunchedEffect(activity, app.client, t.loading) { t.ensure(app, activity) }
    // Spans still running grow with the clock.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val running = t.turns.any { turn -> turn.end == null || turn.spans.any { it.end == null } }
    LaunchedEffect(running) {
        while (running) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    Column(modifier.fillMaxSize()) {
        LensBar {
            KIcon(Lucide.Activity, k.c.muted, 14.dp)
            Text("${t.turns.size} turns · ${traceCalls(t.turns)} tool calls", style = k.ty.uiMedium, color = k.c.fg, maxLines = 1)
            Spacer(Modifier.weight(1f))
            if (t.loading) Spinner()
        }
        if (t.turns.isEmpty() && !t.loading) {
            Box(Modifier.fillMaxWidth().padding(16.dp)) { Text("No tool calls yet.", style = k.ty.body, color = k.c.faint) }
            return@Column
        }
        LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            val ordered = t.turns.withIndex().reversed()
            for ((ti, turn) in ordered) {
                item(key = "turn-$ti") { TurnBlock(app, t, ti, turn, now.toDouble()) }
            }
        }
    }
}

@Composable
private fun TurnBlock(app: AppModel, t: TraceModel, ti: Int, turn: TraceTurn, now: Double) {
    val end = turn.end ?: now
    val total = maxOf(end - turn.start, 1.0)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Turn ${ti + 1}", style = k.ty.textSmallMedium, color = k.c.fg, maxLines = 1)
            Text(firstLine(turn.prompt.orEmpty(), 120), style = k.ty.textSmall, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("${dur(total)} · ${turn.spans.size} calls", style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
        }
        for (sp in turn.spans) SpanRow(app, t, sp, turn.start, total, now)
    }
}

@Composable
private fun SpanRow(app: AppModel, t: TraceModel, sp: TraceSpan, t0: Double, total: Double, now: Double) {
    val end = sp.end ?: now
    val (off, len) = spanBar(sp.start, end, t0, total)
    val open = t.open == sp.id
    val color = when {
        sp.error -> k.c.danger.icon
        sp.end == null -> k.c.info.icon
        else -> k.c.muted
    }
    Column(Modifier.fillMaxWidth()) {
        Pressable({ t.toggle(app, sp.id) }, Modifier.fillMaxWidth().height(26.dp), radius = k.r.sm) {
            Row(Modifier.padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(sp.name, style = k.ty.textSmallMedium, color = k.c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(110.dp))
                Text(sp.detail.orEmpty(), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(280.dp))
                Row(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(2.dp)).background(k.c.chip)) {
                    if (off > 0f) Spacer(Modifier.weight(off))
                    if (len > 0f) Box(Modifier.weight(len).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(color))
                    val rest = 1f - off - len
                    if (rest > 0.0001f) Spacer(Modifier.weight(rest))
                }
                Text(dur(end - sp.start), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1, modifier = Modifier.width(56.dp))
            }
        }
        if (open) {
            val (input, result) = t.tools[sp.id] ?: ("Loading…" to "")
            Block("Input", input)
            if (result.isNotEmpty()) Block("Result", result)
        }
    }
}

@Composable
private fun Block(label: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = k.ty.textXsmallMedium, color = k.c.faint)
        SelectionContainer { Text(clip(body, 40), style = k.ty.mono, color = k.c.muted) }
    }
}
