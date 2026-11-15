package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.int
import dev.qjoly.hooked.data.str
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

class QueryWinTest {
    @Test fun `claude ranges become sliding`() {
        val input = Json.parseToJsonElement("""{"query":"up","start":"2026-11-10T10:00:00Z","end":"2026-11-10T11:00:00Z"}""").jsonObject
        val s = liveSpec("prometheus", input)
        assertEquals("3600s", s["range"].str)
        assertNull(s["start"])
        assertEquals("prometheus", s["tool"].str)
        assertTrue(isQueryTool("mcp__mcp-gateway__grafana_query_loki"))
        assertTrue(isQueryTool("mcp__hooked__show_query"))
    }

    @Test fun `query fences carry their options`() {
        val spec = fenceQuery("promql datasource=mimir-prod range=6h step=5m refresh=10", "sum(rate(x[5m]))\n")!!
        assertEquals("prometheus", spec["tool"].str)
        assertEquals("mimir-prod", spec["datasource"].str)
        assertEquals("sum(rate(x[5m]))", spec["query"].str)
        assertEquals("6h", spec["range"].str)
        assertEquals("5m", spec["step"].str)
        assertEquals(10, spec["refresh"].int)
        assertNull(fenceQuery("promql", "up"))
        val loki = fenceQuery("LogQL ds=loki-prod", "{app=\"x\"}")!!
        assertEquals("loki", loki["tool"].str)
        assertEquals("1h", loki["range"].str)
        assertEquals(30, loki["refresh"].int)
        assertNull(fenceQuery("sql datasource=x", "select 1"))
    }

    @Test fun `numbers read compact`() {
        assertEquals("1.50k", compactNumber(1500.0))
        assertEquals("2.00M", compactNumber(2e6))
        assertEquals("42", compactNumber(42.0))
        assertEquals("0", compactNumber(0.0))
        assertEquals("0.125", compactNumber(0.125))
        assertEquals("–", compactNumber(Double.NaN))
        assertEquals("09:05", hhmm(9 * 3_600_000L + 5 * 60_000L, ZoneOffset.UTC))
    }

    @Test fun `series sort by peak and bounds start at zero when low is far below`() {
        val data = Json.parseToJsonElement("""{"kind":"series","series":[
            {"label":"a","points":[[1000,2],[2000,4]]},
            {"label":"b","points":[[1000,10],[2000,"NaN"],[3000,6]]}]}""")
        val list = seriesOf(data)
        assertEquals(listOf("b", "a"), list.map { it.label })
        assertEquals(6.0, list[0].last, 0.0)
        assertEquals(3.0, list[1].mean, 0.0)
        val b = chartBounds(list)!!
        assertEquals(1000.0, b.t0, 0.0)
        assertEquals(3000.0, b.t1, 0.0)
        assertEquals(0.0, b.lo, 0.0)
        assertEquals(10.0, b.hi, 0.0)
        assertNull(chartBounds(emptyList()))
    }

    @Test fun `titles fall back to the tool and the query`() {
        val spec = Json.parseToJsonElement("""{"tool":"loki","query":"\n{app=\"x\"}\nmore"}""").jsonObject
        assertEquals("loki · {app=\"x\"}", queryTitle(spec))
        assertEquals("query · ", queryTitle(null))
    }
}
