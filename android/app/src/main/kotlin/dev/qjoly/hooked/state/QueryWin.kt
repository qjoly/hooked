package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

// desktop-rune's querywin.rs: a Prometheus or Loki query drawn in a floating window, re-run live.

/** What opens the window: a spec to run, or the result of a query Claude made. `at` tells two identical asks apart. */
sealed interface QueryRequest {
    data class Spec(val spec: JsonObject, val at: Long = System.nanoTime()) : QueryRequest
    data class Result(val session: String, val toolId: String, val at: Long = System.nanoTime()) : QueryRequest
}

/** Auto refresh choices: seconds and label. */
val QUERY_REFRESH = listOf(0 to "Off", 10 to "10s", 30 to "30s", 60 to "1m", 300 to "5m")

fun isQueryTool(name: String) =
    name.endsWith("__grafana_query_prometheus") || name.endsWith("__grafana_query_loki") || name == "mcp__hooked__show_query"

/** Claude's absolute range becomes a range of the same length ending now, so a refresh slides it. */
fun liveSpec(tool: String, input: JsonObject): JsonObject {
    val out = LinkedHashMap(input)
    out["tool"] = JsonPrimitive(tool)
    val a = input["start"].millis
    val b = input["end"].millis
    if (a != null && b != null && b > a) {
        out["range"] = JsonPrimitive("${(b - a) / 1000}s")
        out.remove("start")
        out.remove("end")
    }
    return JsonObject(out)
}

/** ```promql datasource=mimir-prod range=6h step=5m refresh=30, as the web's `fenceQuery`. */
fun fenceQuery(info: String, code: String): JsonObject? {
    val words = info.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val tool = when (words.firstOrNull()?.lowercase()) {
        "promql" -> "prometheus"
        "logql" -> "loki"
        else -> return null
    }
    val meta = words.drop(1).mapNotNull { w -> w.split('=', limit = 2).takeIf { it.size == 2 && it[0].isNotEmpty() }?.let { it[0] to it[1] } }.toMap()
    val ds = meta["datasource"] ?: meta["ds"] ?: return null
    val query = code.trim()
    if (ds.isEmpty() || query.isEmpty()) return null
    val out = linkedMapOf<String, JsonElement>(
        "tool" to JsonPrimitive(tool),
        "datasource" to JsonPrimitive(ds),
        "query" to JsonPrimitive(query),
        "range" to JsonPrimitive(meta["range"] ?: "1h"),
        "refresh" to JsonPrimitive(meta["refresh"]?.toIntOrNull() ?: 30),
    )
    meta["step"]?.let { out["step"] = JsonPrimitive(it) }
    meta["limit"]?.toIntOrNull()?.let { out["limit"] = JsonPrimitive(it) }
    return JsonObject(out)
}

/** The window title: the spec's own, else the tool and the query's first line. */
fun queryTitle(spec: JsonObject?): String {
    spec?.get("title").str?.takeIf { it.isNotEmpty() }?.let { return it }
    val line = spec?.get("query").str.orEmpty().lines().firstOrNull { it.isNotBlank() }.orEmpty().trim()
    return "${spec?.get("tool").str ?: "query"} · ${if (line.length > 80) line.take(80) + "…" else line}"
}

fun compactNumber(v: Double): String {
    val a = kotlin.math.abs(v)
    fun f(n: Int, x: Double) = String.format(Locale.ROOT, "%.${n}f", x)
    return when {
        !v.isFinite() -> "–"
        a >= 1e9 -> f(2, v / 1e9) + "G"
        a >= 1e6 -> f(2, v / 1e6) + "M"
        a >= 1e3 -> f(2, v / 1e3) + "k"
        a >= 10 || a == 0.0 -> f(0, v)
        else -> f(3, v)
    }
}

fun hhmm(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    val t = Instant.ofEpochMilli(ms).atZone(zone)
    return "%02d:%02d".format(t.hour, t.minute)
}

data class Series(val label: String, val points: List<Pair<Double, Double>>, val last: Double, val max: Double, val mean: Double)

/** The series of a result, largest peak first. */
fun seriesOf(data: JsonElement?): List<Series> = data["series"].arr.map { s ->
    val points = s["points"].arr.mapNotNull { p ->
        val t = p.arr.getOrNull(0).dbl ?: return@mapNotNull null
        val v = p.arr.getOrNull(1).dbl ?: return@mapNotNull null
        (t to v).takeIf { v.isFinite() }
    }
    val vals = points.map { it.second }
    Series(
        s["label"].str.orEmpty(), points,
        vals.lastOrNull() ?: Double.NaN,
        vals.maxOrNull() ?: Double.NaN,
        if (vals.isEmpty()) Double.NaN else vals.sum() / vals.size,
    )
}.sortedByDescending { if (it.max.isNaN()) Double.NEGATIVE_INFINITY else it.max }

/** Time and value bounds of a chart; null when there is nothing to draw. */
data class ChartBounds(val t0: Double, val t1: Double, val lo: Double, val hi: Double)

fun chartBounds(list: List<Series>): ChartBounds? {
    val pts = list.flatMap { it.points }
    if (pts.isEmpty()) return null
    val t0 = pts.minOf { it.first }
    val t1 = pts.maxOf { it.first }
    var lo = pts.minOf { it.second }
    var hi = pts.maxOf { it.second }
    if (t0 >= t1 || !lo.isFinite()) return null
    if (lo > 0 && lo < hi * 0.5) lo = 0.0
    if (hi <= lo) hi = lo + 1
    return ChartBounds(t0, t1, lo, hi)
}

val SERIES_LIGHT = listOf(0x2a78d6, 0xeb6834, 0x1baf7a, 0xeda100, 0xe87ba4, 0x008300, 0x6250d6, 0xe34948)
val SERIES_DARK = listOf(0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181, 0x008300, 0x9085e9, 0xe66767)
