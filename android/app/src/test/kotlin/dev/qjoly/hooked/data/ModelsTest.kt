package dev.qjoly.hooked.data

import dev.qjoly.hooked.ui.bucket
import dev.qjoly.hooked.ui.diffOf
import dev.qjoly.hooked.ui.plain
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
    private fun json(s: String) = Json.parseToJsonElement(s)

    @Test fun `session from the list endpoint`() {
        val s = Session.of(json("""{"id":"a","title":"(sans titre)","projectName":"hooked","state":"waiting","live":true,
            "lastActivity":"2026-11-12T20:57:13.207Z","question":{"id":"q","kind":"permission","toolName":"Bash","questions":[]},
            "cache":{"lastRequestAt":"2026-11-12T20:57:13.207Z","ttl":"5m"},"group":{"mother":"m","members":["m","a"]}}"""))
        assertNull(s.title)
        assertEquals("hooked", s.displayTitle)
        assertEquals(SessionState.WAITING, s.state)
        assertTrue(s.hasQuestion && s.question!!.isPermission && s.needsYou)
        assertEquals(1794517033207L, s.lastActivity)
        assertEquals(5 * 60_000L, s.cache!!.ttlMs)
        assertEquals("m", s.motherId)
    }

    @Test fun `message parts and their fallback`() {
        val withParts = Message.of(0, json("""{"role":"assistant","text":"x","parts":[{"type":"text","text":"hi"},{"type":"tool","tool":{"name":"Bash","result":{"a":1}}}]}"""))
        assertEquals(2, withParts.renderParts.size)
        assertEquals("""{"a":1}""", (withParts.renderParts[1] as MessagePart.ToolUse).tool.result)
        val bare = Message.of(1, json("""{"role":"assistant","text":"hello","tools":[{"name":"Read"}]}"""))
        assertEquals(listOf(MessagePart.Text("hello"), MessagePart.ToolUse(Tool(null, "Read", null, null, null))), bare.renderParts)
    }

    @Test fun `capabilities read id-label tuples`() {
        val c = Capabilities.of(json("""{"models":[{"label":"Opus","opts":[["opus","Opus (default)"],["claude-opus-4-8","4.8"]]}],"efforts":["low","high"]}"""))
        assertEquals("Opus", c.modelLabel("opus"))
        assertEquals("Opus 4.8", c.modelLabel("claude-opus-4-8"))
        assertEquals("fable 5.1", c.modelLabel("claude-fable-5-1"))
    }

    @Test fun `usage gauges`() {
        val g = usageGauges(json("""{"account":{"fiveHour":{"pct":29,"resetInMin":142},"sevenDay":{"pct":32},"fable":{"pct":10,"label":"Fable"}}}"""))
        assertEquals(listOf(Gauge("5H", 29, 142), Gauge("7D", 32, null), Gauge("Fable", 10, null)), g)
    }

    @Test fun `edit and write calls become diffs`() {
        val edit = diffOf(Tool(null, "Edit", null, """{"old_string":"a\nb","new_string":"c"}""", null))!!
        assertEquals(listOf('-', '-', '+'), edit.map { it.sign })
        assertEquals(1, diffOf(Tool(null, "Write", null, """{"content":"x"}""", null))!!.size)
        assertNull(diffOf(Tool(null, "Bash", null, """{"command":"ls"}""", null)))
    }

    @Test fun `excerpts drop markdown`() {
        assertEquals("Title • x is done", plain("## Title\n- **x** is done"))
        assertEquals("• Commit : 215412e, signé", plain("- **Commit :** `215412e`, signé"))
    }

    @Test fun `stale sessions leave the needs-you bucket`() {
        // Epoch milliseconds: small numbers would read as seconds.
        val now = 1_794_517_033_207L
        fun s(state: String, live: Boolean, age: Long) = Session.of(json("""{"id":"x","state":"$state","live":$live,"lastActivity":${now - age}}"""))
        assertEquals(0, bucket(s("waiting", false, 3_600_000), now))
        assertEquals(2, bucket(s("waiting", false, 2 * 86_400_000L), now))
        assertEquals(1, bucket(s("working", true, 0), now))
        assertNull(bucket(s("ended", false, 2 * 86_400_000L), now))
    }
}
