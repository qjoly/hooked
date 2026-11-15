package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.Meta
import dev.qjoly.hooked.data.Session
import dev.qjoly.hooked.ui.kit.tagIndex
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneOffset

class OrganizeTest {
    private val now = 1_794_517_033_207L
    private val utc = ZoneOffset.UTC

    private fun s(id: String, state: String = "idle", age: Long = 60_000, q: Boolean = false, live: Boolean = true) =
        Session.of(Json.parseToJsonElement("""{"id":"$id","title":"t$id","state":"$state","live":$live,"hasQuestion":$q,"lastActivity":${now - age}}"""))

    @Test fun `cold ended sessions count as archived`() {
        assertTrue(isArchived(s("a", "ended", 2 * DAY_MS), emptyMap(), now))
        assertFalse(isArchived(s("a", "ended", 3_600_000), emptyMap(), now))
        assertTrue(isArchived(s("a", "idle"), mapOf("a" to Meta(archived = true)), now))
    }

    @Test fun `children follow their mother only when she is listed`() {
        val meta = mapOf("b" to Meta(groupOf = "a"), "c" to Meta(groupOf = "z"))
        val u = units(listOf(s("a"), s("b"), s("c")), meta)
        assertEquals(listOf("a", "c"), u.map { it.lead.id })
        assertEquals(listOf("b"), u[0].children.map { it.id })
    }

    @Test fun `a unit is filed by its most pressing awake member`() {
        val meta = mapOf("b" to Meta(groupOf = "a"), "a" to Meta(snoozeUntil = now + 1000))
        val unit = units(listOf(s("a", "waiting"), s("b", "working")), meta).single()
        assertEquals(Section.WORKING, sectionOf(unit, meta, now))
        assertEquals(Section.SNOOZED, sectionOf(GroupUnit(s("x", "waiting"), emptyList()), mapOf("x" to Meta(snoozeUntil = now + 1)), now))
        assertEquals(Section.WAITING, sectionOf(GroupUnit(s("y", "idle", q = true), emptyList()), emptyMap(), now))
    }

    @Test fun `dynamic sort puts pins, then what needs you, then the most recent`() {
        val list = listOf(s("old", age = 9_000_000), s("new", age = 1_000), s("ask", age = 5_000_000, q = true), s("pin", age = 99_000_000))
        assertEquals(listOf("pin", "ask", "new", "old"), sortSessions(list, "dynamic", setOf("pin"), emptyMap()).map { it.id })
        assertEquals(listOf("pin", "ask", "new", "old"), sortSessions(list, "alpha", setOf("pin"), mapOf("ask" to "a", "new" to "b", "old" to "c")).map { it.id })
    }

    @Test fun `wheel slices run by family then recency, pulling out what needs you`() {
        val slices = wheelSlices(listOf(s("w", "working"), s("q", "idle", q = true), s("e", "ended")), emptyMap(), now)
        assertEquals(listOf("q", "w", "e"), slices.map { it.session.id })
        assertTrue(slices[0].pulled)
        assertEquals(0f, slices[0].start)
        assertEquals(1f, slices[2].end)
        assertEquals(7f / 1000f, wheelGap(10))
    }

    @Test fun `formats match rune`() {
        assertEquals("5s", span(5_000))
        assertEquals("2min", span(125_000))
        assertEquals("now", agoShort(now - 5_000, now))
        assertEquals("—", agoShort(null, now))
        val monday9 = LocalDateTime.of(2026, 11, 16, 9, 0).toInstant(utc).toEpochMilli()
        val friday = LocalDateTime.of(2026, 11, 13, 20, 0).toInstant(utc).toEpochMilli()
        assertEquals("Mon 9:00", wakeLabel(monday9, friday, utc))
        assertEquals("9:00", wakeLabel(monday9, monday9 - 3_600_000, utc))
    }

    @Test fun `snooze presets skip a near evening and a Monday that is tomorrow`() {
        val sunday19 = LocalDateTime.of(2026, 11, 15, 19, 0).toInstant(utc).toEpochMilli()
        assertEquals(listOf("1 hour", "3 hours", "Tomorrow"), snoozePresets(sunday19, utc).map { it.first })
        val friday10 = LocalDateTime.of(2026, 11, 13, 10, 0).toInstant(utc).toEpochMilli()
        assertEquals(listOf("1 hour", "3 hours", "This evening", "Tomorrow", "Monday"), snoozePresets(friday10, utc).map { it.first })
    }

    @Test fun `plain flattens markdown like rune`() {
        assertEquals("Title - x is done", plain("## Title\n- **x** is done", 100))
        assertEquals("see docs · a · b ", plain("see [docs](http://x)\n| a | b |\n|---|---|", 100))
        assertEquals("abc…", plain("abcdef", 3))
    }

    @Test fun `tag colours use the fixed names then the Java hash`() {
        assertEquals(4, tagIndex("infra"))
        assertEquals(tagIndex("bug"), tagIndex("BUG"))
        assertEquals(7, tagIndex("bug", mapOf("bug" to 7)))
        assertEquals(listOf("a", "b"), parseTags("#a, b a"))
    }
}
