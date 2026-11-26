package dev.qjoly.hooked.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GithubLogicTest {
    private fun j(s: String): JsonElement = Json.parseToJsonElement(s)

    private val overview = j(
        """
        {
          "review": [{"repo":"o/a","title":"Bump","url":"https://github.com/o/a/pull/1","updatedAt":"2026-11-10T00:00:00Z","checks":"PENDING"}],
          "mine": [
            {"repo":"o/b","title":"Mine","number":7,"url":"https://github.com/o/b/pull/7","author":"me","updatedAt":"2026-11-12T00:00:00Z",
             "decision":"","reviews":[
               {"author":"me","state":"COMMENTED","at":"2026-11-13T00:00:00Z"},
               {"author":"ann","state":"APPROVED","at":"2026-11-11T00:00:00Z"},
               {"author":"bob","state":"CHANGES_REQUESTED","at":"2026-11-14T00:00:00Z"}
             ]}
          ],
          "issues": [{"repo":"p/c","title":"Upgrade ArgoCD","number":3,"url":"https://github.com/p/c/issues/3","author":"me","updatedAt":"2026-11-01T00:00:00Z"}],
          "notifications": [
            {"id":"11","repo":"o/a","title":"cilium-cli: add maintainer","url":"https://github.com/o/a/pull/9","updatedAt":"2026-11-15T00:00:00Z"},
            {"id":"12","repo":"o/b","subject":"Release v2","url":"https://github.com/o/b/releases/tag/v2","updatedAt":"2026-11-09T00:00:00Z"}
          ]
        }
        """,
    )

    @Test fun `the filter scopes by repo prefix and needs every other word`() {
        val x = j("""{"repo":"acme/Infra.Charts","title":"ARC stall alert"}""")
        assertTrue(ghKeep("", x))
        assertTrue(ghKeep("acme/ stall", x))
        assertTrue(ghKeep("charts", x))
        assertFalse(ghKeep("gitbluub/ stall", x))
        assertFalse(ghKeep("stall pprof", x))
    }

    @Test fun `latest reviews skip my own and come newest first with the pull request fields`() {
        val r = ghReviews(overview)
        assertEquals(listOf("bob", "ann"), r.map { it["author"].str })
        assertEquals("Mine", r[0]["title"].str)
        assertEquals("o/b", r[0]["repo"].str)
        assertEquals(7, r[0]["number"].int)
        assertEquals("2026-11-14T00:00:00Z", r[0]["updatedAt"].str)
    }

    @Test fun `items narrow to the picked repo and the query`() {
        assertEquals(2, ghItems(overview, "notifications", "", null).size)
        assertEquals(1, ghItems(overview, "notifications", "", "o/a").size)
        assertEquals(listOf("12"), ghItems(overview, "notifications", "release", null).map { it["id"].str })
        assertEquals(2, ghItems(overview, "reviews", "", "o/b").size)
        assertTrue(ghItems(null, "review", "", null).isEmpty())
    }

    @Test fun `repos count every tab and sort by latest update`() {
        val r = ghRepos(overview)
        assertEquals(listOf("o/a", "o/b", "p/c"), r.map { it.repo })
        assertEquals(2, r[0].count)
        // The pull request, its two reviews from others and a notification.
        assertEquals(4, r[1].count)
        assertEquals("2026-11-14T00:00:00Z", r[1].latest)
    }

    @Test fun `decision falls back to a review's state, an empty decision shows nothing`() {
        assertEquals("Approved" to "ok", ghRowDecision(j("""{"state":"APPROVED"}""")))
        assertEquals("Changes requested" to "ko", ghRowDecision(j("""{"decision":"CHANGES_REQUESTED"}""")))
        assertNull(ghRowDecision(j("""{"decision":"","state":"APPROVED"}""")))
        assertNull(ghRowDecision(j("""{}""")))
    }

    @Test fun `check tones`() {
        assertEquals("ok", ghCheckTone("SUCCESS"))
        assertEquals("ko", ghCheckTone("ERROR"))
        assertEquals("wait", ghCheckTone("PENDING"))
        assertNull(ghCheckTone(null))
    }

    @Test fun `meta line leaves out what an item lacks`() {
        assertEquals("o/b #7 · me · 3h", ghMetaLine(ghItems(overview, "mine", "", null)[0], "3h"))
        assertEquals("o/a · now", ghMetaLine(ghItems(overview, "notifications", "", null)[0], "now"))
    }

    @Test fun `titles fall back to the subject, and only pulls and issues peek`() {
        assertEquals("Release v2", ghTitle(ghAll(overview, "notifications")[1]))
        assertTrue(ghPeekable("https://github.com/o/a/pull/9"))
        assertTrue(ghPeekable("https://github.com/p/c/issues/3"))
        assertFalse(ghPeekable("https://github.com/o/b/releases/tag/v2"))
    }

    @Test fun `marked notifications leave the overview`() {
        val v = withoutNotifications(overview, listOf("11"))
        assertEquals(listOf("12"), v["notifications"].arr.map { it["id"].str })
        assertEquals(1, v["issues"].arr.size)
        assertNull(withoutNotifications(null, listOf("11")))
    }
}
