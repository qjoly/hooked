package dev.qjoly.hooked.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

class CronScheduleTest {
    private val utc = ZoneOffset.UTC
    private val paris = ZoneId.of("Europe/Paris")

    private fun at(s: String, zone: ZoneId = utc) = LocalDateTime.parse(s).atZone(zone).toInstant().toEpochMilli()
    private fun local(ms: Long, zone: ZoneId = utc) = Instant.ofEpochMilli(ms).atZone(zone).toLocalDateTime().toString()

    @Test fun `schedules parse like the web`() {
        assertNull(validCron("0 17 * * 1-5"))
        assertNull(validCron("@daily"))
        assertNull(validCron("*/15 * * * *"))
        assertNull(validCron("5/15 9-17 1,15 * 1"))
        assertEquals("minute out of range: \"61\"", validCron("61 * * * *"))
        assertEquals("invalid hour: \"x\"", validCron("0 x * * *"))
        assertEquals("expected 5 fields: minute hour day-of-month month day-of-week", validCron("* * *"))
        assertEquals("minute out of range: \"*/0\"", validCron("*/0 * * * *"))
        assertEquals("day of month out of range: \"5-2\"", validCron("0 0 5-2 * *"))
    }

    @Test fun `steps start from the given value`() {
        assertEquals(setOf(5, 20, 35, 50), CronSchedule.parse("5/15 * * * *").minute)
        assertEquals(setOf(0), CronSchedule.parse("0 0 * * 7").dow)
    }

    @Test fun `next run is the first matching minute strictly after`() {
        val runs = nextRuns("30 9 * * *", 2, at("2026-11-15T09:30:00"), utc)
        assertEquals(listOf("2026-11-16T09:30", "2026-11-17T09:30"), runs.map { local(it) })
        assertEquals("2026-11-15T09:31", local(nextRuns("* * * * *", 1, at("2026-11-15T09:30:59"), utc).single()))
    }

    @Test fun `weekdays skip the weekend`() {
        // 2026-11-14 is a Saturday.
        val runs = nextRuns("0 9 * * 1-5", 3, at("2026-11-14T12:00:00"), utc)
        assertEquals(listOf("2026-11-16T09:00", "2026-11-17T09:00", "2026-11-18T09:00"), runs.map { local(it) })
    }

    @Test fun `both day fields restricted match either`() {
        // The 1st of the month or any Friday.
        val runs = nextRuns("0 0 1 * 5", 3, at("2026-11-02T00:00:00"), utc)
        assertEquals(listOf("2026-11-06T00:00", "2026-11-13T00:00", "2026-11-20T00:00"), runs.map { local(it) })
        val dec = nextRuns("0 0 1 * 5", 3, at("2026-11-26T00:00:00"), utc)
        assertEquals(listOf("2026-11-27T00:00", "2026-12-01T00:00", "2026-12-04T00:00"), dec.map { local(it) })
    }

    @Test fun `an impossible date never runs`() {
        assertTrue(nextRuns("0 0 30 2 *", 3, at("2026-01-01T00:00:00"), utc).isEmpty())
        assertEquals("Never runs" to PreviewTone.WARNING, cronPreview("0 0 30 2 *", at("2026-01-01T00:00:00"), utc))
    }

    @Test fun `local time survives a DST change`() {
        // Paris leaves summer time on 2026-10-25: 9:00 stays 9:00 local.
        val runs = nextRuns("0 9 * * *", 2, at("2026-10-24T10:00:00", paris), paris)
        assertEquals(listOf("2026-10-25T09:00", "2026-10-26T09:00"), runs.map { local(it, paris) })
    }

    @Test fun `preview and stamp read like rune`() {
        assertEquals("Mon 16 Nov 09:00", cronStamp(at("2026-11-16T09:00:00"), utc))
        val (msg, tone) = cronPreview("@daily", at("2026-11-15T12:00:00"), utc)
        assertEquals("Next: Mon 16 Nov 00:00 · Tue 17 Nov 00:00 · Wed 18 Nov 00:00", msg)
        assertEquals(PreviewTone.FAINT, tone)
        assertEquals(PreviewTone.DANGER, cronPreview("nope", 0, utc).second)
    }
}
