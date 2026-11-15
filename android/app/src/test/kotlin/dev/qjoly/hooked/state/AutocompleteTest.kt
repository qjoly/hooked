package dev.qjoly.hooked.state

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AutocompleteTest {
    @Test
    fun commandsOnlyFromTheStart() {
        assertEquals(AcQuery.Command("co"), acQuery("/co"))
        assertEquals(AcQuery.Command("plugin:run-x"), acQuery("/plugin:run-x"))
        assertNull(acQuery("/co mmit"))
        assertNull(acQuery("see /co"))
    }

    @Test
    fun filesAfterAnAtOnAWordBoundary() {
        assertEquals(AcQuery.File("src/ap", 5), acQuery("look @src/ap"))
        assertEquals(AcQuery.File("", 0), acQuery("@"))
        assertNull(acQuery("mail me@host"))
        assertNull(acQuery("look @src/a b"))
    }

    @Test
    fun itemsAndInsertion() {
        val files = acItems(Json.parseToJsonElement("""{"files":["a/b/app.yaml"]}"""), files = true)
        assertEquals(AcItem("@a/b/app.yaml ", "app.yaml", "a/b/app.yaml", ""), files[0])
        val cmds = acItems(
            Json.parseToJsonElement("""{"commands":[{"name":"cost","description":"Show cost","group":"builtin"},{"name":"ship","group":"custom","source":"skill"}]}"""),
            files = false,
        )
        assertEquals("built-in", cmds[0].badge)
        assertEquals("skill", cmds[1].badge)
        assertEquals("look @a/b/app.yaml  now" to 19, acApply("look @a/b now", 5, 9, files[0]))
    }
}
