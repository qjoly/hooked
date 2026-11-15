package dev.qjoly.hooked.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionDataTest {
    private fun j(s: String) = Json.parseToJsonElement(s)

    @Test fun `worktrees fold into their checkout only when asked`() {
        assertEquals("/r", pickerPath("/r/.claude/worktrees/x", null, true))
        assertEquals("/r/.claude/worktrees/x", pickerPath("/r/.claude/worktrees/x", null, false))
        assertEquals("/main", pickerPath("/wt/abcd1234", "/main", true))
        assertEquals("/wt/abcd1234", pickerPath("/wt/abcd1234", "/main", false))
    }

    @Test fun `favourites first, then the most recent projects, once each`() {
        val seen = listOf(
            SeenProject("/old", null, 1),
            SeenProject("/new", null, 3),
            SeenProject("/fav", null, 2),
            SeenProject(null, null, 9),
            SeenProject("/r/.claude/worktrees/x", null, 4),
        )
        assertEquals(
            listOf("/fav" to true, "/r" to false, "/new" to false, "/old" to false),
            launchProjects(listOf("/fav"), seen, collapse = true),
        )
        val many = (1..20).map { "/p$it" to false }
        assertEquals(14, filterProjects(many, "").size)
        assertEquals(listOf("/p2" to false, "/p20" to false), filterProjects(many, " P2 "))
    }

    @Test fun `folder hues follow rune's hash`() {
        assertEquals(0, folderHueIndex(""))
        assertEquals(("a".hashCode().toLong() % 5).toInt(), folderHueIndex("a"))
        assertTrue(folderHueIndex("/Users/me/code/hooked") in 0..4)
        // A long path overflows the 32-bit hash; the index stays in range.
        assertTrue(folderHueIndex("/".repeat(40) + "é".repeat(40)) in 0..4)
    }

    @Test fun `saved prompts append after a blank line`() {
        assertEquals("do it", appendPrompt("  \n", "do it"))
        assertEquals("first\n\ndo it", appendPrompt("first\n", "do it"))
    }

    @Test fun `a spent Fable default falls back to Opus`() {
        val spent = j("""{"account":{"fable":{"pct":100,"label":"Fable","resetInMin":125}}}""")
        val fine = j("""{"account":{"fable":{"pct":10,"severity":"exhausted"}}}""")
        val bySeverity = j("""{"account":{"fable":{"severity":"Exhausted","resetInMin":12}}}""")
        assertTrue(newFallback("claude-fable-5-2", spent))
        assertTrue(newFallback("fable", bySeverity))
        assertFalse(newFallback("fable", fine))
        assertFalse(newFallback("claude-opus-5", spent))
        assertNull(fableSpent(null))
        assertEquals("Fable weekly limit reached (resets in 2h). Defaulting to Opus so the session doesn't fail on its first turn.", fableNotice(fableSpent(spent)))
        assertEquals("Fable weekly limit reached (resets in 12m). Defaulting to Opus so the session doesn't fail on its first turn.", fableNotice(fableSpent(bySeverity)))
    }

    @Test fun `the launch mode comes from hooked, then Claude Code`() {
        assertEquals("plan", initialMode(j("""{"defaultMode":"plan"}"""), "auto"))
        assertEquals("auto", initialMode(j("""{"defaultMode":""}"""), "auto"))
        assertEquals("default", initialMode(j("{}"), "dontAsk"))
        assertEquals("default", initialMode(null, null))
    }

    @Test fun `the launch body carries the worktree spec and drops empty fields`() {
        val base = LaunchRequest("/p", "go", null, "high", "auto", incognito = false, worktree = false, ephemeral = true)
        assertEquals(
            j("""{"cwd":"/p","prompt":"go","effort":"high","permissionMode":"auto","incognito":false,"worktree":false,"ephemeral":true}"""),
            base.json(),
        )
        assertEquals(j("""{"base":"origin/main"}"""), base.copy(worktree = true, base = " origin/main ", branch = " ").json()["worktree"])
        assertEquals(j("{}"), base.copy(worktree = true).json()["worktree"])
    }
}
