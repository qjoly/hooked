package dev.qjoly.hooked.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalApiTest {
    @Test
    fun readsDescribedTerminals() {
        val j = Json.parseToJsonElement(
            """{"id":"term_0a1b2c","cwd":"/tmp/p","sessionId":"s1","inline":false,"shell":"/bin/zsh","cols":120,"rows":32,"startedAt":"2026-01-01T00:00:00Z","exited":true,"exitCode":0}""",
        )
        assertEquals(TermInfo("term_0a1b2c", "/tmp/p", "s1", false, 120, 32, true, 0), TermInfo.of(j))
    }

    @Test
    fun sseLinesCarryBase64Bytes() {
        assertEquals("ls\r\n", String(sseBytes("data: bHMNCg==")!!))
        assertEquals("é", String(sseBytes("data:w6k=")!!, Charsets.UTF_8))
        assertNull(sseBytes(": ping"))
        assertNull(sseBytes("retry: 2000"))
        assertNull(sseBytes("data: %%%"))
        assertTrue(sseBytes("data: ") == null)
    }
}
