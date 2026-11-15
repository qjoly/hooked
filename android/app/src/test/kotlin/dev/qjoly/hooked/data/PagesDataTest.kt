package dev.qjoly.hooked.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PagesDataTest {
    private fun j(s: String) = Json.parseToJsonElement(s)

    @Test fun `token counts shorten like rune`() {
        assertEquals("793.5M", tokens(793_483_335.0))
        assertEquals("2.7M", tokens(2_737_560.0))
        assertEquals("9.0k", tokens(9_044.0))
        assertEquals("1.2B", tokens(1.2e9))
        assertEquals("812", tokens(812.0))
    }

    @Test fun `spans and limits read like the usage cards`() {
        assertEquals("resets in 2 h", resetsLabel(172.0))
        assertEquals("resets in 14 h", resetsLabel(862.0))
        assertEquals("resets in 45 min", resetsLabel(45.0))
        assertEquals("—", resetsLabel(null))
        assertEquals("of 1M tokens", contextSizeLabel(1_000_000.0))
        assertEquals("of 200k tokens", contextSizeLabel(200_000.0))
        assertEquals("97%", pctLabel(97.0))
    }

    @Test fun `ranking sorts largest first against the largest`() {
        val by = j("""{"claude-fable-5-1":{"cost":350.2},"claude-opus-5-5":{"cost":700.4},"claude-sonnet-5-5":{"cost":7}}""")
        val bars = ranked(by, "cost", label = ::shortModel)
        assertEquals(listOf("opus-5-5", "fable-5-1", "sonnet-5-5"), bars.map { it.label })
        assertEquals(1f, bars[0].frac)
        assertEquals(0.5f, bars[1].frac, 0.001f)
        val tools = ranked(j("""{"Bash":40,"mcp__hooked__list_sessions":10,"Read":20}"""), null, take = 2, floor = 1.0, label = ::toolLabel)
        assertEquals(listOf("Bash", "Read"), tools.map { it.label })
        assertEquals(0f, ranked(j("""{"x":{"cost":0}}"""), "cost").single().frac)
    }

    @Test fun `cost days keep the last month in date order`() {
        val days = costDays(j("""{"2026-11-12":{"cost":2,"turns":3},"2026-11-08":{"cost":1}}"""))
        assertEquals(listOf("2026-11-08", "2026-11-12"), days.map { it.date })
        assertEquals(0.0, days[0].turns, 0.0)
        assertEquals("11-12", dayLabel(days[1].date))
        val many = j((10..49).joinToString(",", "{", "}") { "\"d$it\":{\"cost\":$it}" })
        assertEquals(31, costDays(many).size)
    }

    @Test fun `dates shift across months and reject junk`() {
        assertEquals("2026-11-14", shiftDate("2026-11-15", -1))
        assertEquals("2026-12-01", shiftDate("2026-11-30", 1))
        assertEquals("2027-01-01", shiftDate("2026-12-31", 1))
        assertEquals("2026-03-03", shiftDate("2026-02-31", 0))
        assertNull(shiftDate("2026-13-01", 0))
        assertNull(shiftDate("yesterday", 0))
        assertNull(shiftDate("2026/11/15", 0))
    }

    @Test fun `first line trims and cuts`() {
        assertEquals("hello", firstLine("\n  \n  hello  \nworld", 10))
        assertEquals("abc…", firstLine("abcdef", 3))
        assertEquals("", firstLine("", 3))
    }

    @Test fun `memories filter by type and text and drop empty projects`() {
        val v = j(
            """{"projects":[
            {"name":"a","cwd":"/a","memories":[{"file":"x.md","name":"Alloy","type":"reference","body":"river"},{"file":"y.md","type":"project","description":"Deploy notes","body":""}]},
            {"name":"b","cwd":null,"memories":[{"file":"z.md","name":"Zed","type":"feedback","body":"terse"}]}
            ],"total":3}""",
        )
        val all = memoryProjects(v)
        assertEquals("y.md", all[0].memories[1].name)
        assertNull(all[1].cwd)
        assertEquals(listOf("a"), filterMemories(all, "project", "").map { it.name })
        assertEquals(listOf("b"), filterMemories(all, null, "TERSE").map { it.name })
        assertEquals(listOf("x.md"), filterMemories(all, null, "river").single().memories.map { it.file })
        assertEquals(2, filterMemories(all, null, " ").size)
    }

    @Test fun `skills group by source in first-seen order`() {
        val list = j(
            """[{"id":"1","name":"boileau","description":"French","source":"user"},
            {"id":"2","name":"docx","description":"Word","source":"plugin"},
            {"id":"3","name":"pdf","description":"PDF files","source":"user"},
            {"id":"4","name":"misc"}]""",
        ).arr
        assertEquals(listOf("user", "plugin", "other"), skillGroups(list, "").map { it.first })
        assertEquals(listOf("3"), skillGroups(list, "pdf").single().second.map { it["id"].str })
        assertEquals("version: 0.1.0  ·  tools: [\"Read\"]  ·  n: 2", skillMeta(j("""{"name":"x","version":"0.1.0","description":"d","tools":["Read"],"n":2}""")))
    }

    @Test fun `prompt library round-trips`() {
        val list = promptLibrary(j("""{"promptLibrary":[{"name":"Review","text":"Review this"}]}"""))
        assertEquals(listOf(SavedPrompt("Review", "Review this")), list)
        assertEquals(list, promptLibrary(j("""{"promptLibrary":${promptLibraryJson(list)}}""")))
        assertEquals(emptyList<SavedPrompt>(), promptLibrary(j("{}")))
    }

    @Test fun `links route like rune's open_link`() {
        val base = "http://host:4123"
        assertEquals(LinkTarget.Session("abc"), linkTarget("/session/abc?x=1", base))
        assertEquals(LinkTarget.Open("http://host:4123/api/x"), linkTarget("/api/x", base))
        assertEquals(LinkTarget.Open("https://github.com/a/b"), linkTarget("github.com/a/b", base))
        assertEquals(LinkTarget.Open("https://x.dev"), linkTarget(" https://x.dev ", base))
        assertEquals("**HIGHLIGHTS**\n\n- a\n- b", bulletBlock("HIGHLIGHTS", listOf("a", "b")))
    }
}
