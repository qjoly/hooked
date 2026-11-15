package dev.qjoly.hooked.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsDataTest {
    private fun j(s: String) = Json.parseToJsonElement(s)

    @Test fun `a nested save sends the whole object with one field changed`() {
        val s = j("""{"autoCompact":{"enabled":false,"minContextK":100}}""")
        assertEquals(j("""{"enabled":true,"minContextK":100}"""), withNested(s, "autoCompact", "enabled", JsonPrimitive(true)))
        assertEquals(j("""{"display":"replace"}"""), withNested(s, "sidebarCache", "display", JsonPrimitive("replace")))
    }

    @Test fun `missing booleans fall back to the server default`() {
        val s = j("""{"autoTags":false,"showWork":null}""")
        assertFalse(s["autoTags"].boolOr(true))
        assertTrue(s["showWork"].boolOr(true))
        assertTrue(s["missing"].boolOr(true))
    }

    @Test fun `lists toggle and days stay sorted`() {
        assertEquals(listOf("a", "c"), toggled(listOf("a", "b", "c"), "b"))
        assertEquals(listOf("a", "b"), toggled(listOf("a"), "b"))
        assertEquals(listOf(0, 1, 5), toggledDay(listOf(1, 5), 0))
        assertEquals(listOf(1), toggledDay(listOf(1, 5), 5))
    }

    @Test fun `working hours round-trip and reject garbage`() {
        val s = j("""{"warmup":{"workHours":[["09:00","12:00"],["14:00","18:00"]]}}""")
        assertEquals("09:00-12:00, 14:00-18:00", workHoursText(s))
        assertEquals(j("""[["09:00","12:00"],["14:00","18:00"]]"""), parseWorkHours(" 09:00-12:00 ,14:00 - 18:00"))
        assertEquals(j("""[["08:30","11:00"]]"""), parseWorkHours("8:00-9:00, 08:30-11:00"))
        assertNull(parseWorkHours("morning"))
        assertNull(parseWorkHours(""))
    }

    @Test fun `the warm-up hint reads the scheduler state`() {
        val base = "Keep a usage window open across your working hours with a tiny early ping."
        assertEquals(base, warmupHint(null))
        assertEquals(
            "$base Scheduler right now: disabled · window open until 19:29 (73% used).",
            warmupHint(j("""{"decision":{"act":false,"reason":"disabled"},"fiveHour":{"pct":73,"at":"19:29"}}""")),
        )
        assertEquals("$base Scheduler right now: ping due.", warmupHint(j("""{"decision":{"act":true}}""")))
    }

    @Test fun `server paths shorten the home folder`() {
        assertEquals("~/code/hooked", tilde("/Users/qjoly/code/hooked"))
        assertEquals("~", tilde("/home/me"))
        assertEquals("/Volumes/Stockage/x", tilde("/Volumes/Stockage/x"))
    }

    @Test fun `clean-up and pull reports read like rune`() {
        val cleanup = j(
            """{"removed":[{"path":"/Users/me/wt/a","branch":"feat/a","reason":"archived","branchDeleted":true}],
               "kept":[{"path":"/Users/me/wt/b","why":"dirty"}],"failed":[]}""",
        )
        assertEquals(
            listOf("Removed ~/wt/a (feat/a) · archived, branch deleted" to false, "Kept ~/wt/b · dirty" to true),
            cleanupReport(cleanup),
        )
        assertEquals(listOf("Nothing to clean up." to false), cleanupReport(j("{}")))
        val pull = j(
            """{"checkouts":[{"path":"/Users/me/a","branch":"main","result":"pulled","commits":1},
               {"path":"/Users/me/b","result":"up to date"},{"path":"/Users/me/c","result":"skipped","why":"dirty"}]}""",
        )
        assertEquals(
            listOf("Pulled 1 commit into ~/a (main)" to false, "Skipped ~/c · dirty" to false, "1 checkout up to date." to false),
            pullReport(pull),
        )
        assertEquals(listOf("0 checkouts up to date." to false), pullReport(j("""{"checkouts":[]}""")))
    }

    @Test fun `retag renames in place, dedups and drops bare sessions`() {
        val tags = mapOf("a" to listOf("x", "old", "y"), "b" to listOf("old"), "c" to listOf("new", "old"))
        assertEquals(mapOf("a" to listOf("x", "new", "y"), "b" to listOf("new"), "c" to listOf("new")), retag(tags, "old", "new"))
        assertEquals(mapOf("a" to listOf("x", "y"), "c" to listOf("new")), retag(tags, "old", null))
        assertEquals("infra", cleanTag("  #Infra "))
    }

    @Test fun `tag counts sort by name and respect incognito`() {
        val tags = mapOf("a" to listOf("z", "b"), "b" to listOf("b"))
        assertEquals(listOf("b" to 2, "z" to 1), tagCounts(tags))
        assertEquals(listOf("b" to 1), tagCounts(tags, setOf("b")))
    }

    @Test fun `remote control lists favourites, projects then the ones on`() {
        val s = j("""{"favoriteProjects":["/f"],"remoteControlProjects":["/on","/f"]}""")
        assertEquals(listOf("/f", "/p", "/on"), remoteProjects(s, listOf("/p", "/f")))
        val rc = j("""{"projects":[{"cwd":"/on","status":"running"},{"cwd":"/x","state":"stopped"}]}""")
        assertEquals("running", rcStatus(rc, "/on"))
        assertEquals("stopped", rcStatus(rc, "/x"))
        assertEquals("", rcStatus(rc, "/none"))
    }

    @Test fun `model labels carry their family once`() {
        val caps = Capabilities.of(j("""{"models":[{"label":"Opus","opts":[["opus","Opus (default)"],["claude-opus-5","5"]]}],"efforts":[]}"""))
        assertEquals(listOf(ModelOption("opus", "Opus (default)"), ModelOption("claude-opus-5", "Opus 5")), flatModels(caps))
        assertEquals(listOf("opus"), visibleModels(caps, j("""{"hiddenModels":["claude-opus-5"]}""")).map { it.id })
    }

    @Test fun `branch chips skip locked ones and mark remote ones`() {
        val git = j(
            """{"branches":[{"name":"main","current":true},{"name":"wt","locked":true},
               {"name":"origin/x","remote":true}]}""",
        )
        assertEquals(listOf(BranchChip("main", "main", true), BranchChip("origin/x", "origin/x ↓", false)), branchChips(git))
    }

    @Test fun `stepper labels`() {
        assertEquals("always", windowLabel(0))
        assertEquals("15 min", windowLabel(15))
        assertEquals("07:00", hourLabel(7))
        assertEquals("23:00", hourLabel(23))
    }
}
