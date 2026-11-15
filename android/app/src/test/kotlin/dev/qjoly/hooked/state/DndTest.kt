package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.Meta
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DndTest {
    @Test fun `the innermost box under the pointer wins`() {
        val boxes = mapOf(
            "sb:a" to DropBox(0f, 0f, 300f, 40f),
            "sb:b" to DropBox(0f, 40f, 300f, 40f),
            "repo:hooked" to DropBox(400f, 0f, 600f, 30f),
            "fl:c" to DropBox(400f, 0f, 100f, 20f),
        )
        assertEquals(Drop.Session("b"), hitDrop(boxes, 10f, 50f, "a"))
        assertNull(hitDrop(boxes, 10f, 10f, "a"))
        assertEquals(Drop.Detach, hitDrop(boxes, 700f, 10f, "a"))
        assertEquals(Drop.Session("c"), hitDrop(boxes, 450f, 10f, "a"))
        assertNull(hitDrop(boxes, 350f, 10f, "a"))
    }

    @Test fun `a drop must change the group`() {
        val meta = mapOf("b" to Meta(groupOf = "a"), "c" to Meta(groupOf = "a"))
        assertFalse(dropAllowed("b", Drop.Session("a"), meta))
        assertFalse(dropAllowed("b", Drop.Session("c"), meta))
        assertTrue(dropAllowed("d", Drop.Session("c"), meta))
        assertEquals("a", leadOf("c", meta))
        assertTrue(dropAllowed("b", Drop.Detach, meta))
        assertFalse(dropAllowed("a", Drop.Detach, meta))
    }

    @Test fun `hot targets follow the hovered drop`() {
        assertTrue(dropHot("fl:x", Drop.Session("x")))
        assertTrue(dropHot("sb:x", Drop.Session("x")))
        assertFalse(dropHot("sb:y", Drop.Session("x")))
        assertTrue(dropHot("repo:hooked", Drop.Detach))
        assertFalse(dropHot("sb:x", null))
    }
}
