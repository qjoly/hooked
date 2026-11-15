package dev.qjoly.hooked.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.grafanaConnected
import dev.qjoly.hooked.data.grafanaLoginUrl
import dev.qjoly.hooked.data.grafanaQuery
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.obj
import dev.qjoly.hooked.data.queryResult
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.QUERY_REFRESH
import dev.qjoly.hooked.state.QueryRequest
import dev.qjoly.hooked.state.SERIES_DARK
import dev.qjoly.hooked.state.SERIES_LIGHT
import dev.qjoly.hooked.state.Series
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.state.chartBounds
import dev.qjoly.hooked.state.compactNumber
import dev.qjoly.hooked.state.hhmm
import dev.qjoly.hooked.state.liveSpec
import dev.qjoly.hooked.state.queryTitle
import dev.qjoly.hooked.state.seriesOf
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import dev.qjoly.hooked.ui.session.Segmented
import dev.qjoly.hooked.ui.session.openUrl
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.math.roundToInt

@Stable
private class QueryWinModel {
    var spec by mutableStateOf<JsonObject?>(null)
    var data by mutableStateOf<JsonElement?>(null)
    var err by mutableStateOf<String?>(null)
    var login by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var updated by mutableStateOf<Long?>(null)
    var refresh by mutableStateOf(30)
    var loginPolled by mutableStateOf(0L)
    var ran = 0L

    suspend fun run(client: HookedClient) {
        val s = spec ?: return
        if (loading) return
        loading = true
        ran = System.currentTimeMillis()
        try {
            val (_, j) = client.grafanaQuery(s)
            when {
                j["login"].bool -> {
                    login = true
                    err = null
                }
                j["error"] != null -> err = j["error"].str
                else -> {
                    login = false
                    err = null
                    data = j["data"]
                    updated = System.currentTimeMillis()
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            err = e.message
        } finally {
            loading = false
        }
    }

    suspend fun load(client: HookedClient, req: QueryRequest) {
        when (req) {
            is QueryRequest.Spec -> {
                spec = req.spec
                refresh = req.spec["refresh"].int ?: 30
                run(client)
            }
            is QueryRequest.Result -> try {
                val v = client.queryResult(req.session, req.toolId)
                val input = v["input"].obj ?: JsonObject(emptyMap())
                spec = liveSpec(v["tool"].str.orEmpty(), input)
                val d = v["data"]
                if (d == null || d is kotlinx.serialization.json.JsonNull) {
                    refresh = input["refresh"].int ?: 30
                    run(client)
                } else {
                    data = d
                    // Claude's result shows first; the live re-runs start one period later.
                    ran = System.currentTimeMillis()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                err = e.message
            }
        }
    }
}

/** Where the window sits, from the bottom-right corner; it stays put between openings, as rune's `float_at`. */
private var floatAt by mutableStateOf(Offset(16f, 16f))

/** rune's floating query window: a draggable panel over the bottom right that charts the query and re-runs it. */
@Composable
fun QueryWindow(app: AppModel) {
    val req = app.queryRequest ?: return
    val client = app.client ?: return
    val w = remember(req) { QueryWinModel() }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    LaunchedEffect(req) { w.load(client, req) }
    LaunchedEffect(req) {
        while (true) {
            delay(1_000)
            val now = System.currentTimeMillis()
            if (w.login && w.loginPolled > 0) {
                if (now - w.loginPolled > 2_000) {
                    w.loginPolled = now
                    if (runCatching { client.grafanaConnected() }.getOrDefault(false)) {
                        w.login = false
                        w.run(client)
                    }
                }
            } else if (!w.login && w.refresh > 0 && !w.loading && w.spec != null && now - w.ran > w.refresh * 1000L) {
                w.run(client)
            }
        }
    }
    val c = k.c
    val density = LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = minOf(760.dp, maxWidth)
        val height = minOf(maxOf(maxHeight * 0.7f, 320.dp), maxHeight)
        val maxX = with(density) { (maxWidth - width).toPx().coerceAtLeast(0f) }
        val maxY = with(density) { (maxHeight - height).toPx().coerceAtLeast(0f) }
        fun clamp(o: Offset) = Offset(o.x.coerceIn(0f, maxX), o.y.coerceIn(0f, maxY))
        val at = clamp(floatAt)
        val shape = RoundedCornerShape(k.r.lg)
        Column(
            Modifier.align(Alignment.BottomEnd)
                .offset { IntOffset(-at.x.roundToInt(), -at.y.roundToInt()) }
                .size(width, height)
                .shadow(16.dp, shape, ambientColor = c.shadow, spotColor = c.shadow)
                .clip(shape).background(c.bg).border(1.dp, c.border, shape)
                // The window is not a scrim: what it covers stays usable, but touches on it stop here.
                .clickable(remember { MutableInteractionSource() }, indication = null) {},
        ) {
            val line = c.border
            val status = when {
                w.updated != null -> "live · updated ${agoShort(w.updated, app.now.coerceAtLeast(w.updated!!))} ago"
                w.data != null -> "Claude's result"
                else -> ""
            }
            Row(
                Modifier.fillMaxWidth().height(40.dp)
                    .drawBehind { drawLine(line, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }
                    .pointerInput(maxX, maxY) { detectDragGestures { ch, d -> ch.consume(); floatAt = clamp(floatAt - d) } }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(queryTitle(w.spec), style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(status, style = k.ty.textXsmall, color = c.faint, maxLines = 1)
                Segmented(QUERY_REFRESH.map { it.second }, QUERY_REFRESH.indexOfFirst { it.first == w.refresh }.coerceAtLeast(0)) { w.refresh = QUERY_REFRESH[it].first }
                KButton(if (w.loading) "Running…" else "Run", { scope.launch { w.run(client) } }, variant = Variant.GHOST_MUTED, size = Size.SMALL, enabled = !w.loading && w.spec != null)
                KButton("Close", { app.queryRequest = null }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
            }
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                val inner = maxWidth
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    QueryBody(w, inner) {
                        scope.launch {
                            val url = runCatching { client.grafanaLoginUrl() }.getOrNull()
                            if (url == null) {
                                app.say("✗ Could not start the mcp-gateway sign-in")
                            } else {
                                openUrl(ctx, url)
                                w.login = true
                                w.loginPolled = System.currentTimeMillis()
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QueryBody(w: QueryWinModel, width: Dp, signIn: () -> Unit) {
    val c = k.c
    if (w.login) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("hooked isn't connected to mcp-gateway yet, so it can't run the query itself.", style = k.ty.textSmall, color = c.muted)
            KButton(if (w.loginPolled > 0) "Waiting for the sign-in…" else "Sign in to mcp-gateway", signIn, variant = Variant.CONTRAST)
        }
        return
    }
    w.err?.let {
        Text(it, style = k.ty.textSmall, color = c.danger.fg, modifier = Modifier.padding(16.dp))
        return
    }
    val d = w.data ?: run {
        Text("Loading…", style = k.ty.textSmall, color = c.faint, modifier = Modifier.padding(16.dp))
        return
    }
    val palette = (if (k.dark) SERIES_DARK else SERIES_LIGHT).map { Color(0xFF000000 or it.toLong()) }
    fun color(i: Int) = palette.getOrElse(i) { Color(0xFF8A8A99) }
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (d["kind"].str) {
            "series" -> {
                val list = remember(d) { seriesOf(d) }
                Chart(list, width - 24.dp, ::color)
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Spacer(Modifier.weight(1f))
                        listOf("last", "max", "mean").forEach { Text(it, style = k.ty.textXsmallMedium, color = c.faint, modifier = Modifier.width(64.dp)) }
                    }
                    list.take(30).forEachIndexed { i, se ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.size(10.dp, 3.dp).clip(RoundedCornerShape(1.5.dp)).background(color(i)))
                            Text(se.label, style = k.ty.textXsmall, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            listOf(se.last, se.max, se.mean).forEach { Text(compactNumber(it), style = k.ty.mono, color = c.muted, modifier = Modifier.width(64.dp)) }
                        }
                    }
                }
            }
            "table" -> d["rows"].arr.take(200).forEach { r ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(r["label"].str.orEmpty(), style = k.ty.textSmall, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(compactNumber(r["value"].dbl ?: Double.NaN), style = k.ty.mono, color = c.muted)
                }
            }
            "logs" -> {
                Text("${d["total"].int ?: 0} lines", style = k.ty.textXsmall, color = c.faint)
                SelectionContainer {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        d["lines"].arr.take(500).forEach { l ->
                            val level = l["level"].str.orEmpty()
                            val (fg, bg) = when (level) {
                                "error", "fatal", "critical" -> c.danger.fg to c.danger.bg
                                "warn", "warning" -> c.warning.fg to c.warning.bg
                                else -> c.muted to c.chip
                            }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
                                Text(hhmm((l["t"].dbl ?: 0.0).toLong()), style = k.ty.mono, color = c.faint)
                                if (level.isNotEmpty()) Pill(level, fg, bg)
                                Text(l["line"].str.orEmpty(), style = k.ty.mono, color = c.fg, modifier = Modifier.weight(1f))
                            }
                        }
                    }
                }
            }
            else -> Text(d["error"].str ?: "No result", style = k.ty.textSmall, color = c.danger.fg)
        }
    }
}

/** The series as 1.6 wide lines over four grid lines, the value axis on the left and the time span below. */
@Composable
private fun Chart(list: List<Series>, width: Dp, color: (Int) -> Color) {
    val c = k.c
    val b = remember(list) { chartBounds(list) }
    if (b == null) {
        Text("No data points in this range.", style = k.ty.textSmall, color = c.faint)
        return
    }
    val h = 220.dp
    val plotW = (width - 50.dp).coerceAtLeast(120.dp)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Column(Modifier.width(44.dp).height(h), horizontalAlignment = Alignment.End) {
                Text(compactNumber(b.hi), style = k.ty.textXsmall, color = c.faint)
                Spacer(Modifier.weight(1f))
                Text(compactNumber((b.hi + b.lo) / 2), style = k.ty.textXsmall, color = c.faint)
                Spacer(Modifier.weight(1f))
                Text(compactNumber(b.lo), style = k.ty.textXsmall, color = c.faint)
            }
            val grid = c.border
            Canvas(Modifier.size(plotW, h)) {
                val pw = size.width
                val ph = size.height
                for (i in 0..3) {
                    val y = ph * i / 3f
                    drawLine(grid, Offset(0f, y), Offset(pw, y), 1.dp.toPx())
                }
                val pad = 2.dp.toPx()
                for (i in list.indices.reversed()) {
                    val pts = list[i].points
                    if (pts.isEmpty()) continue
                    val path = Path()
                    pts.forEachIndexed { j, (t, v) ->
                        val x = ((t - b.t0) / (b.t1 - b.t0)).toFloat() * pw
                        val y = ph - ((v - b.lo) / (b.hi - b.lo)).toFloat() * (ph - 2 * pad) - pad
                        if (j == 0) path.moveTo(x, y) else path.lineTo(x, y)
                    }
                    drawPath(path, color(i), style = Stroke(1.6.dp.toPx(), join = StrokeJoin.Round))
                }
            }
        }
        Row(Modifier.padding(start = 50.dp).width(plotW)) {
            Text(hhmm(b.t0.toLong()), style = k.ty.textXsmall, color = c.faint)
            Spacer(Modifier.weight(1f))
            Text(hhmm(b.t1.toLong()), style = k.ty.textXsmall, color = c.faint)
        }
    }
}
