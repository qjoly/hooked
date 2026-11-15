package dev.qjoly.hooked.ui.pages

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.DayCost
import dev.qjoly.hooked.data.STATS_RANGES
import dev.qjoly.hooked.data.contextSizeLabel
import dev.qjoly.hooked.data.costDays
import dev.qjoly.hooked.data.count
import dev.qjoly.hooked.data.dayLabel
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.obj
import dev.qjoly.hooked.data.ranked
import dev.qjoly.hooked.data.resetsLabel
import dev.qjoly.hooked.data.shortModel
import dev.qjoly.hooked.data.stats
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.tokens
import dev.qjoly.hooked.data.toolLabel
import dev.qjoly.hooked.data.usageRaw
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.state.costLabel
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

class StatsModel : PageModel() {
    var range by mutableIntStateOf(0)
    var stats by mutableStateOf<JsonElement?>(null)
        private set
    var usage by mutableStateOf<JsonElement?>(null)
        private set
    private var loadedFor: Int? = null
    private var loading: Job? = null

    /** Entering the page refetches, as rune's `go(Page::Stats)` clears `stats_loaded_for`. */
    fun enter(app: AppModel) {
        loadedFor = null
        ensure(app)
    }

    fun pick(app: AppModel, i: Int) {
        range = i
        ensure(app)
    }

    private fun ensure(app: AppModel) {
        if (loadedFor == range) return
        val r = range
        loadedFor = r
        loading?.cancel()
        loading = call(app, "Stats") { stats = it.stats(STATS_RANGES[r].first) }
    }

    fun loadUsage(app: AppModel) {
        call(app, "Usage") { usage = it.usageRaw() }
    }
}

/** rune's Stats page: usage limits, totals, cost per day, and cost by model, tool and project. */
@Composable
fun StatsPage(app: AppModel) {
    val m: StatsModel = viewModel()
    LaunchedEffect(Unit) { m.enter(app) }
    LaunchedEffect(Unit) {
        while (true) {
            m.loadUsage(app)
            delay(60_000)
        }
    }
    PageFrame("Stats", actions = { PageSegmented(STATS_RANGES.map { it.second }, m.range, { m.pick(app, it) }) }) {
        val v = m.stats
        if (v == null) PageLoading() else StatsBody(app, m, v)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatsBody(app: AppModel, m: StatsModel, v: JsonElement) {
    val t = v["totals"]
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Centered(1100.dp) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                m.usage?.let { UsageCards(app, it) }
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Tile("COST", costLabel(t["cost"].dbl))
                    Tile("SESSIONS", count(t["sessions"].dbl))
                    Tile("PROMPTS", count(t["prompts"].dbl))
                    Tile("TURNS", count(t["turns"].dbl))
                    Tile("OUTPUT", tokens(t["output"].dbl ?: 0.0))
                    Tile("CACHE READ", tokens(t["cacheRead"].dbl ?: 0.0))
                }
                PageCard("COST PER DAY", Modifier.fillMaxWidth()) { CostChart(costDays(v["byDay"])) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.Top) {
                    PageCard("BY MODEL", Modifier.weight(1f)) {
                        for (b in ranked(v["byModel"], "cost", label = ::shortModel)) HBar(b, costLabel(b.value), k.c.success.icon)
                    }
                    PageCard("TOOLS", Modifier.weight(1f)) {
                        for (b in ranked(v["byTool"], null, take = 12, floor = 1.0, label = ::toolLabel)) HBar(b, count(b.value), k.c.muted)
                    }
                }
                PageCard("BY PROJECT", Modifier.fillMaxWidth()) {
                    for (b in ranked(v["byProject"], "cost", take = 12)) HBar(b, costLabel(b.value), k.c.warning.icon)
                }
            }
        }
    }
}

@Composable
private fun Tile(label: String, value: String) {
    val shape = RoundedCornerShape(k.r.lg)
    Column(
        Modifier.width(170.dp).clip(shape).background(k.c.surface).border(1.dp, k.c.border, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        SectionTitle(label)
        Text(value, style = k.ty.bodyMedium, color = k.c.fg, maxLines = 1)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UsageCards(app: AppModel, u: JsonElement) {
    val a = u["account"]
    val x = u["session"]
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        UsageCard("Account limits", Modifier.weight(1f).widthIn(min = 280.dp)) {
            UsageBar("5-hour", a["fiveHour"]["pct"].dbl, resetsLabel(a["fiveHour"]["resetInMin"].dbl))
            UsageBar("7-day", a["sevenDay"]["pct"].dbl, resetsLabel(a["sevenDay"]["resetInMin"].dbl))
            a["fable"].obj?.let { f -> UsageBar(f["label"].str ?: "Fable", f["pct"].dbl, resetsLabel(f["resetInMin"].dbl)) }
            a["at"].millis?.let { Text("updated ${agoShort(it, app.now)} ago", style = k.ty.textXsmall, color = k.c.faint) }
        }
        UsageCard("Current session", Modifier.weight(1f).widthIn(min = 280.dp)) {
            if (x.obj != null) {
                UsageBar("Context", x["context"]["pct"].dbl, contextSizeLabel(x["context"]["size"].dbl))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Pill("Effort: ${x["effort"].str ?: "—"}", k.c.muted, k.c.chip)
                    Pill("Model: ${x["modelName"].str ?: x["modelId"].str ?: "—"}", k.c.muted, k.c.chip)
                    if ((x["fastMode"] as? JsonPrimitive)?.booleanOrNull == true) Pill("Fast", k.c.warning.fg, k.c.warning.bg)
                }
            } else {
                Text("No active session snapshot.", style = k.ty.textSmall, color = k.c.faint)
            }
        }
    }
}

@Composable
private fun UsageCard(title: String, modifier: Modifier, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(k.r.lg)
    Column(
        modifier.clip(shape).background(k.c.surface).border(1.dp, k.c.border, shape).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = k.ty.uiMedium, color = k.c.fg)
        content()
    }
}

/**
 * rune's cost-per-day columns (h 160, gap 6, bars ≤ 36 wide and ≤ 122 tall, date under each).
 * The hover help becomes a tap: the tapped day shows "date · cost · turns" above its bar.
 */
@Composable
private fun CostChart(days: List<DayCost>) {
    var picked by remember(days) { mutableStateOf<Int?>(null) }
    val measurer = rememberTextMeasurer()
    val c = k.c
    val labelStyle = k.ty.textXsmall.copy(color = c.faint)
    val tipStyle = k.ty.textXsmall.copy(color = c.fg)
    val maxCost = (days.maxOfOrNull { it.cost } ?: 0.0).coerceAtLeast(0.01)
    Canvas(
        Modifier.fillMaxWidth().height(160.dp).pointerInput(days) {
            detectTapGestures { p ->
                if (days.isEmpty()) return@detectTapGestures
                val gap = 6.dp.toPx()
                val col = (size.width - gap * (days.size - 1)) / days.size
                val i = (p.x / (col + gap)).toInt().coerceIn(0, days.size - 1)
                picked = if (picked == i) null else i
            }
        },
    ) {
        if (days.isEmpty()) return@Canvas
        val gap = 6.dp.toPx()
        val n = days.size
        val col = (size.width - gap * (n - 1)) / n
        val barW = minOf(col, 36.dp.toPx())
        val labelH = 18.dp.toPx()
        val base = size.height - labelH - 4.dp.toPx()
        val radius = CornerRadius(3.dp.toPx())
        // Show every k-th date when a label is wider than its column.
        val sample = measurer.measure("00-00", labelStyle).size.width
        val every = maxOf(1, kotlin.math.ceil(sample / (col + gap)).toInt())
        days.forEachIndexed { i, d ->
            val x0 = i * (col + gap)
            val h = (d.cost / maxCost * 120.0).toFloat().dp.toPx() + 2.dp.toPx()
            val color = if (picked == null || picked == i) c.info.icon else c.info.icon.copy(alpha = 0.45f)
            drawRoundRect(color, Offset(x0 + (col - barW) / 2, base - h), Size(barW, h), radius)
            if ((n - 1 - i) % every == 0) {
                val l = measurer.measure(dayLabel(d.date), labelStyle)
                drawText(l, topLeft = Offset(x0 + col / 2 - l.size.width / 2f, size.height - l.size.height))
            }
        }
        picked?.let { i ->
            val d = days[i]
            val tip = measurer.measure("${d.date} · ${costLabel(d.cost)} · ${count(d.turns)} turns", tipStyle)
            val padX = 8.dp.toPx()
            val padY = 4.dp.toPx()
            val w = tip.size.width + padX * 2
            val h = tip.size.height + padY * 2
            val barH = (d.cost / maxCost * 120.0).toFloat().dp.toPx() + 2.dp.toPx()
            val cx = i * (col + gap) + col / 2
            val left = (cx - w / 2).coerceIn(0f, (size.width - w).coerceAtLeast(0f))
            val top = (base - barH - h - 6.dp.toPx()).coerceAtLeast(0f)
            val r = CornerRadius(6.dp.toPx())
            drawRoundRect(c.surface, Offset(left, top), Size(w, h), r)
            drawRoundRect(c.border, Offset(left, top), Size(w, h), r, style = Stroke(1.dp.toPx()))
            drawText(tip, topLeft = Offset(left + padX, top + padY))
        }
    }
}
