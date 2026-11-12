package dev.qjoly.hooked

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WaitingTest {
    private fun s(id: String, state: String = "working", q: Boolean = false, snooze: Long = 0) =
        SessionInfo(id, "t-$id", "p", state, q, snooze)

    @Test fun `kinds mirror notifyKeyFor`() {
        assertEquals(Kind.QUESTION, kindOf(s("a", "background", q = true)))
        assertEquals(Kind.ATTENTION, kindOf(s("a", "attention")))
        assertEquals(Kind.WAITING, kindOf(s("a", "waiting")))
        assertEquals(Kind.ENDED, kindOf(s("a", "ended")))
        for (st in listOf("working", "idle", "background")) assertNull(kindOf(s("a", st)))
    }

    @Test fun `first pass only records`() {
        val pass = Tracker().update(listOf(s("a", "waiting")), 0)
        assertTrue(pass.fresh.isEmpty())
        assertEquals(listOf("a"), pass.waiting.map { it.first.id })
    }

    @Test fun `notifies on rising edges and kind changes only`() {
        val t = Tracker()
        t.update(listOf(s("a"), s("b", "waiting")), 0)
        val pass = t.update(listOf(s("a", "waiting"), s("b", "waiting"), s("c", "attention")), 0)
        assertEquals(listOf("a" to Kind.WAITING, "c" to Kind.ATTENTION), pass.fresh.map { it.first.id to it.second })
        val ended = t.update(listOf(s("a", "ended"), s("b", "waiting"), s("c", "attention")), 0)
        assertEquals(listOf("a" to Kind.ENDED), ended.fresh.map { it.first.id to it.second })
    }

    @Test fun `clears sessions that stop waiting or leave`() {
        val t = Tracker()
        t.update(listOf(s("a", "waiting"), s("b", "attention"), s("c")), 0)
        val pass = t.update(listOf(s("a", "working")), 0)
        assertEquals(setOf("a", "b"), pass.cleared.toSet())
    }

    @Test fun `waiting count leaves out snoozed and ended sessions`() {
        val pass = Tracker().update(listOf(s("a", "waiting", snooze = 2_000), s("b", "ended"), s("c", q = true), s("d", "waiting", snooze = 500)), 1_000)
        assertEquals(listOf("c", "d"), pass.waiting.map { it.first.id })
    }
}
