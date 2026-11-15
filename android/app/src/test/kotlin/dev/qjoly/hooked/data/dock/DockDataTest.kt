package dev.qjoly.hooked.data.dock

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DockDataTest {
    private fun dock(s: String) = DockData.of(Json.parseToJsonElement(s))

    private val sample = dock(
        """{
        "todos":[
          {"content":"Write tests","status":"completed","activeForm":"Writing tests"},
          {"content":"Port the dock","status":"in_progress","activeForm":"Porting the dock"},
          {"content":"A","status":"pending","activeForm":""},{"content":"B","status":"pending"},
          {"content":"C","status":"pending"},{"content":"D","status":"pending"}],
        "changes":[{"file":"/a/b/Kit.kt","name":"Kit.kt","ops":[{},{},{}]},{"file":"/a/b/c.rs","ops":[{}]}],
        "subagents":[
          {"id":"t1","type":"general-purpose","description":"Spec rune","prompt":"\n\nFirst line\nsecond","result":"done",
           "model":"claude-opus-4-8","totalTokens":12345,"durationMs":41600,"cost":0.5,"agentId":"a1"},
          {"id":"t2","type":"","description":"","model":null,"totalTokens":null,"durationMs":null,"cost":null}],
        "subSessions":[{"id":"s1","label":"","source":"created"},{"id":"s2","label":"Named"}],
        "workflows":[{"name":"review","status":"running","doneCount":2,"agentCount":5},{"name":"x","status":"killed","doneCount":"1","agentCount":"1"}],
        "bgJobs":[
          {"taskId":"b1","description":"","label":"npm test","command":"npm test","done":true,"exitCode":0,"doneReason":"completed"},
          {"taskId":"b2","description":"Tail logs","label":"tail","command":"tail -f x","done":false,"exitCode":null},
          {"taskId":"b3","description":"Record","command":"rec.sh","done":true,"exitCode":143,"doneReason":"failed"},
          {"taskId":"b4","description":"Tunnel","command":"cloudflared","done":true,"exitCode":null,"doneReason":"killed"}],
        "prLinks":["https://github.com/qjoly/hooked/pull/105"],
        "issueLinks":["https://github.com/qjoly/hooked/issues/7"],
        "screenshots":[{"path":"/tmp/a.png","name":"a.png","ts":"2026-11-15T15:29:41.737Z"},{"path":"/tmp/b.png","name":"b.png","ts":"2026-11-15T15:30:44.569Z"},{"name":"no path"}]
        }""",
    )

    @Test fun `parses the dock fields of a session detail`() {
        assertEquals(6, sample.todos.size)
        assertEquals(DockChange("/a/b/Kit.kt", "Kit.kt", 3), sample.changes[0])
        assertEquals("c.rs", sample.changes[1].label)
        assertEquals(listOf(DockSub("s1", null), DockSub("s2", "Named")), sample.subSessions)
        assertEquals(2, sample.links.size)
        assertEquals(listOf("/tmp/b.png", "/tmp/a.png"), sample.sortedShots.map { it.path })
        assertTrue(sample.hasContent)
        assertFalse(dock("{}").hasContent)
        assertFalse(dock("""{"messages":[{"role":"user"}]}""").hasContent)
    }

    @Test fun `card counts read as rune words them`() {
        assertEquals("1/6", sample.todoCount)
        assertEquals("2 files", sample.changeCount)
        assertEquals("1 file", dock("""{"changes":[{"file":"x"}]}""").changeCount)
        assertEquals("1 running", sample.workflowCount)
        assertEquals("1", dock("""{"workflows":[{"name":"w","status":"completed"}]}""").workflowCount)
        assertEquals("2 · $0.50", sample.agentCount)
        assertEquals("1 running · 4", sample.jobCount)
        assertEquals(1f / 6, sample.todoProgress, 1e-6f)
    }

    @Test fun `folded tasks show the current one then three pending`() {
        assertEquals(listOf("Porting the dock", "A", "B", "C"), sample.shownTodos(false).map { it.label })
        assertEquals(6, sample.shownTodos(true).size)
        assertEquals("Write tests", sample.todos[0].label)
    }

    @Test fun `agents label and meta`() {
        val (a, b) = sample.subagents
        assertEquals("general-purpose · Spec rune", a.label)
        assertEquals("opus-4-8 · 12345 tokens · 42s · $0.50", a.meta)
        assertEquals("a1", a.agentId)
        assertEquals("agent", b.label)
        assertEquals(" · 0 tokens · 0s · $0.00", b.meta)
        assertEquals(null, b.agentId)
    }

    @Test fun `workflows map their status to a state`() {
        val (running, killed) = sample.workflows
        assertEquals("working", running.state)
        assertEquals("2/5", running.progress)
        assertEquals("attention", killed.state)
        assertEquals("1/1", killed.progress)
        assertEquals("ended", DockWorkflow("w", "done", 0.0, 0.0).state)
        assertEquals("idle", DockWorkflow("w", "queued", 0.0, 0.0).state)
    }

    @Test fun `background jobs sort running first and read their exit`() {
        assertEquals(listOf("b2", "b1", "b3", "b4"), sample.sortedJobs.map { it.taskId })
        val byId = sample.bgJobs.associateBy { it.taskId }
        assertEquals("npm test", byId.getValue("b1").title)
        assertEquals("exit 0", byId.getValue("b1").status)
        assertEquals("ended", byId.getValue("b1").state)
        assertEquals("running", byId.getValue("b2").status)
        assertEquals("working", byId.getValue("b2").state)
        assertEquals("attention", byId.getValue("b3").state)
        assertEquals("exit 143", byId.getValue("b3").status)
        assertEquals("killed", byId.getValue("b4").status)
        assertEquals("ended", byId.getValue("b4").state)
    }

    @Test fun `review link counts the hidden files`() {
        assertEquals("+35 more · open Review →", reviewLinkLabel(41, false))
        assertEquals("Open Review →", reviewLinkLabel(41, true))
        assertEquals("Open Review →", reviewLinkLabel(6, false))
    }

    @Test fun `first line skips blanks and cuts`() {
        assertEquals("First line", firstLine("\n\n  First line  \nsecond", 2000))
        assertEquals("abc…", firstLine("abcdef", 3))
        assertEquals("", firstLine("  \n ", 10))
    }

    @Test fun `logs lose their escapes`() {
        assertEquals("ok 50%\n80%\ndone", stripAnsi("\u001b[1;32mok\u001b[0m 50%\r80%\r\n\u001b]0;title\u0007done"))
        assertEquals("ab", stripAnsi("a\u001b]8;;http://x\u001b\\b"))
    }

    @Test fun `job log keeps its tail`() {
        assertEquals("cdef", appendLog("abc", "def", cap = 4))
        assertEquals("waiting for output…", logTail(""))
        assertEquals("2\n3", logTail("1\n2\n3\n", lines = 2))
    }

    @Test fun `short ages`() {
        assertEquals("—", agoShort(null, 0))
        assertEquals("now", agoShort(1_000, 5_000))
        assertEquals("42s", agoShort(0, 42_000))
        assertEquals("5min", agoShort(0, 5 * 60_000L))
        assertEquals("3h", agoShort(0, 3 * 3_600_000L))
        assertEquals("2d", agoShort(0, 2 * 86_400_000L))
    }
}
