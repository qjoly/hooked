package dev.qjoly.hooked.data.lens

import org.junit.Assert.assertEquals
import org.junit.Test

class TraceLogicTest {
    @Test fun `durations read like rune's`() {
        assertEquals("320ms", dur(320.0))
        assertEquals("2.5s", dur(2500.0))
        assertEquals("3m5s", dur(185_000.0))
    }

    @Test fun `a span bar is a sliver at least and stays inside the turn`() {
        assertEquals(0.5f to 0.25f, spanBar(50.0, 75.0, 0.0, 100.0))
        assertEquals(0.0f to 0.004f, spanBar(0.0, 0.0, 0.0, 100.0))
        assertEquals(1.0f to 0.0f, spanBar(200.0, 300.0, 0.0, 100.0))
    }

    @Test fun `long bodies are clipped with a count`() {
        assertEquals("a\nb\n… 1 more lines", clip("a\nb\nc\n", 2))
        assertEquals("a\nb", clip("a\nb", 2))
    }
}
