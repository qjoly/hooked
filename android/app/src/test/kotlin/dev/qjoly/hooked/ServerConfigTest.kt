package dev.qjoly.hooked

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerConfigTest {
    @Test fun `pairing link`() {
        assertEquals(ServerConfig("192.168.1.20", 4123, false), ServerConfig.fromLink("hooked://connect?host=192.168.1.20&port=4123"))
        assertEquals(ServerConfig("mac.ts.net", 443, true), ServerConfig.fromLink("hooked://connect?host=https%3A%2F%2Fmac.ts.net%2F&port=443&https=1"))
        assertEquals(ServerConfig("h", 4123, false), ServerConfig.fromLink("hooked://connect?host=h&port=99999"))
        assertNull(ServerConfig.fromLink("hooked://connect?port=1"))
        assertNull(ServerConfig.fromLink("https://connect?host=h"))
        assertNull(ServerConfig.fromLink("hooked://other?host=h"))
    }

    @Test fun `base url`() {
        assertEquals("http://h:4123", ServerConfig("h").base)
        assertEquals("https://[fd00::1]:8443", ServerConfig("fd00::1", 8443, true).base)
        assertEquals("host", ServerConfig.cleanHost(" http://host/dash "))
    }
}
