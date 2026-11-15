package dev.qjoly.hooked.state

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationTest {
    private val detail = Json.parseToJsonElement(
        """
        {"id":"s1","title":"Fix the proxy","project":"/p","model":"claude-opus-5-5","cost":1.5,
         "context":{"pct":22.4},"changes":[{"file":"a"},{"file":"b"}],"startTs":"2026-11-15T14:02:38.395Z",
         "followupSuggestion":"ship it","costBreak":{"input":1},"usage":{"input":10},
         "messages":[
          {"role":"user","ts":"2026-11-15T14:02:41.573Z","text":"look /Users/q/.claude/hooked/images/a.png now","forkUuid":"u1"},
          {"role":"assistant","ts":"2026-11-15T14:03:00Z","text":"done","forkUuid":"u2","tools":[{"name":"Bash"}],
           "parts":[{"type":"text","text":"  "},{"type":"text","text":"done"},
                    {"type":"tool","tool":{"id":"t1","name":"Edit","detail":"a.kt","result":{"ok":true}},
                     "diff":{"file":"a.kt","ops":[{"kind":"edit","old":"a","new":"b"}]},
                     "show":{"kind":"image","path":"/after.png","compare":"/before.png"}},
                    {"type":"tool","tool":{"name":"Write"},"diff":{"ops":[]}}]},
          {"role":"assistant","text":"plain","tools":[{"name":"Read","detail":"x"}]}
         ]}
        """,
    )

    @Test
    fun readsWhatTheSharedModelsLeaveOut() {
        val c = Conversation.of(detail)
        assertEquals(22.4, c.contextPct!!, 0.001)
        assertEquals(2, c.changes)
        assertEquals("ship it", c.followup)
        assertEquals("u1", c.turns[0].forkUuid)
        assertEquals("2026-11-15T14:02:41.573Z", c.turns[0].tsRaw)
    }

    @Test
    fun partsDropBlankTextAndEmptyDiffs() {
        val parts = Conversation.of(detail).turns[1].parts
        assertEquals(3, parts.size)
        val edit = (parts[1] as TurnPart.Call).tool
        assertEquals("{\n    \"ok\": true\n}", edit.result)
        assertEquals(listOf("/before.png", "/after.png"), toolMedia(edit))
        assertNull((parts[2] as TurnPart.Call).tool.diff)
    }

    @Test
    fun partsFallBackToTextThenTools() {
        val parts = Conversation.of(detail).turns[2].parts
        assertEquals(TurnPart.Text("plain"), parts[0])
        assertEquals("Read", (parts[1] as TurnPart.Call).tool.name)
    }

    @Test
    fun pastedImagesSplitOutOfThePrompt() {
        // The space around a removed path stays, as rune and the web leave it.
        assertEquals(listOf("/Users/q/.claude/hooked/images/a.png") to "look  now", splitMessageImages("look /Users/q/.claude/hooked/images/a.png now"))
        assertEquals(emptyList<String>() to "no /tmp/a.png here", splitMessageImages("no /tmp/a.png here"))
    }

    @Test
    fun bigDiffsCountTheirLines() {
        val d = Json.parseToJsonElement("""{"ops":[{"kind":"edit","old":"a\nb","new":"c"},{"kind":"write","content":"1\n2\n3"}]}""").jsonObject
        assertEquals(5, diffLineCount(d))
    }

    @Test
    fun formatting() {
        assertEquals("opus-5-5", shortModelId("claude-opus-5-5"))
        assertEquals("42 min", spanSep(42 * 60_000L))
        assertEquals("3m4s", elapsedLabel(184))
        assertEquals("1.2M", tokensLabel(1_234_567.0))
        assertEquals("a…", firstLine("\n  abc\nzz", 1))
        assertEquals("1\n2\n… 1 more lines", clipLines("1\n2\n3", 2))
        assertEquals(
            "Feedback on the plan — please keep planning and revise:\n\n> a\n> b\nfix it",
            composePlanFeedback(listOf("a\nb" to "fix it")),
        )
    }
}
