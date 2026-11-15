package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.Message
import dev.qjoly.hooked.data.Meta
import dev.qjoly.hooked.data.PendingQuestion
import dev.qjoly.hooked.data.Session
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class QuickTest {
    private val now = 1_794_517_033_207L

    private fun s(id: String, state: String, extra: String = "", age: Long = 60_000) =
        Session.of(Json.parseToJsonElement("""{"id":"$id","title":"t$id","state":"$state","lastActivity":${now - age}$extra}"""))

    @Test fun `lists what needs you, minus the archived and the cold`() {
        val list = listOf(
            s("a", "waiting"), s("b", "working"), s("c", "attention"),
            s("d", "idle", ""","hasPlan":true"""), s("e", "waiting"), s("f", "ended", ""","hasQuestion":true""", age = 3 * DAY_MS),
        )
        val items = quickItems(list, mapOf("e" to Meta(archived = true)), now)
        assertEquals(listOf("a", "c", "d"), items.map { it.id })
        assertEquals("plan to review", quickReason(items[2]))
        assertEquals("action required", quickReason(items[1]))
        assertEquals("finished its turn", quickReason(items[0]))
    }

    @Test fun `messages flatten tools and end on the pending question`() {
        val m = Json.parseToJsonElement(
            """[{"role":"user","text":"go"},{"role":"system","text":"x"},
               {"role":"assistant","parts":[{"type":"text","text":"ok"},{"type":"tool","tool":{"name":"Bash","detail":"ls"}}]}]""",
        ).let { j -> (j as kotlinx.serialization.json.JsonArray).mapIndexed { i, e -> Message.of(i, e) } }
        val q = PendingQuestion.of(Json.parseToJsonElement("""{"id":"q","questions":[{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}"""))
        val out = quickMessages(m, q)
        assertEquals(listOf(true, false, false), out.map { it.user })
        assertEquals("ok\n\n`Bash` ls", out[1].text)
        assertEquals("**Which?**\n\n1. A\n2. B", out[2].text)
        assertEquals(2, quickStep(0, 3, -1))
        assertEquals(0, quickStep(2, 3, 1))
    }
}
