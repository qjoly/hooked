package dev.qjoly.hooked.data.dock

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GhLogicTest {
    @Test fun `link labels for GitHub and GitLab`() {
        assertEquals("hooked #105", linkLabel("https://github.com/qjoly/hooked/pull/105"))
        assertEquals("hooked #7", linkLabel("https://github.com/qjoly/hooked/issues/7"))
        assertEquals("flint !10", linkLabel("https://gitlab.com/mineural/flint/-/merge_requests/10"))
        assertEquals("GitOps #7", linkLabel("https://gitlab.com/mineural/infrastructure-kubernetes/GitOps/-/work_items/7"))
        assertEquals("https://gitlab.com/o/r/-/tree/main", linkLabel("https://gitlab.com/o/r/-/tree/main"))
        assertEquals("https://example.com/x", linkLabel("https://example.com/x"))
    }

    @Test fun `pull links and tab numbers`() {
        assertTrue(isPullLink("https://github.com/o/r/pull/1"))
        assertTrue(isPullLink("https://gitlab.com/o/r/-/merge_requests/2"))
        assertFalse(isPullLink("https://github.com/o/r/issues/3"))
        assertEquals("#105", linkNumber("https://github.com/o/r/pull/105"))
    }

    @Test fun `checks sort and summarise`() {
        val statuses = listOf("passed", "pending", "cancelled", "failed", "skipped")
        assertEquals(listOf("failed", "cancelled", "pending", "passed", "skipped"), statuses.sortedBy(::checkRank))
        assertEquals(listOf("cancelled", "failed", "pending", "passed", "skipped"), statuses.sortedBy(::dockCheckRank))
        assertEquals(ChecksSummary("2 of 5 failing", "ko"), checksSummary(statuses))
        assertEquals(ChecksSummary("2 of 5 checks failing", "ko"), checksSummary(statuses, dock = true))
        assertEquals(ChecksSummary("1 of 2 running", "wait"), checksSummary(listOf("pending", "passed")))
        assertEquals(ChecksSummary("All checks passed", "ok"), checksSummary(listOf("passed", "skipped")))
        assertNull(checksSummary(emptyList()))
        assertEquals("Running", checkLabel("pending"))
        assertEquals("Neutral", checkLabel("neutral"))
        assertEquals("attention", checkState("cancelled"))
        assertEquals("background", checkState("pending"))
        assertEquals("working", checkState("passed"))
        assertEquals("idle", checkState("skipped"))
    }

    @Test fun `detail state and decision badges`() {
        assertEquals("Closed" to "merged", detailState("issue", "CLOSED"))
        assertEquals("Closed" to "closed", detailState("pr", "CLOSED"))
        assertEquals("Merged" to "merged", detailState("pr", "MERGED"))
        assertEquals("Open" to "open", detailState("pr", "OPEN"))
        assertEquals("Unknown" to "muted", detailState("pr", ""))
        assertEquals("Changes requested" to "ko", decisionBadge("CHANGES_REQUESTED"))
        assertNull(decisionBadge(""))
    }

    @Test fun `fix prompt matches the web`() {
        assertEquals(
            "The CI check \"lint\" fails on https://github.com/o/r/pull/2 (logs: https://ci/1). Investigate why and fix it.",
            fixPrompt("lint", "https://ci/1", "https://github.com/o/r/pull/2"),
        )
        assertEquals("The CI check \"x\" fails on u. Investigate why and fix it.", fixPrompt("x", "", "u"))
    }

    @Test fun `comment excerpt and file letters`() {
        assertEquals(" Title bold code  quote", commentExcerpt("# Title **bold** `code`\n> quote"))
        assertEquals(120, commentExcerpt("a".repeat(300)).length)
        assertEquals("A", changeLetter("ADDED"))
        assertEquals("·", changeLetter("COPIED"))
    }

    @Test fun `timeline verbs`() {
        assertEquals("committed" to "faint", timelineVerb("commit", ""))
        assertEquals("approved" to "ok", timelineVerb("review", "APPROVED"))
        assertEquals("requested changes" to "ko", timelineVerb("review", "CHANGES_REQUESTED"))
        assertEquals("pending" to "faint", timelineVerb("review", "PENDING"))
        assertEquals("commented" to "faint", timelineVerb("comment", ""))
    }

    @Test fun `splits a patch into typed lines`() {
        val lines = patchLines("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n")
        assertEquals(
            listOf(PatchKind.META, PatchKind.META, PatchKind.META, PatchKind.META, PatchKind.HUNK, PatchKind.CTX, PatchKind.DEL, PatchKind.ADD),
            lines.map { it.kind },
        )
        assertEquals(listOf("keep", "old", "new"), lines.takeLast(3).map { it.text })
        assertEquals(listOf(" ", "-", "+"), lines.takeLast(3).map { it.sign })
    }

    @Test fun `run urls`() {
        assertEquals("34", parseRunUrl("https://github.com/o/r/actions/runs/12/job/34"))
        assertEquals("", parseRunUrl("https://github.com/o/r/actions/runs/12"))
        assertEquals("", parseRunUrl("https://github.com/o/r/actions/runs/12/?check_suite_focus=true"))
        assertNull(parseRunUrl("https://github.com/o/r/pull/12"))
        assertNull(parseRunUrl("https://gitlab.com/o/r/actions/runs/12"))
    }

    @Test fun `link targets`() {
        val base = "http://host:4123"
        assertEquals(LinkTarget.Session("abc"), linkTarget("/session/abc?x=1", base))
        assertEquals(LinkTarget.Run("https://github.com/o/r/actions/runs/1"), linkTarget(" https://github.com/o/r/actions/runs/1 ", base))
        assertEquals(LinkTarget.Open("https://dashboard.gitguardian.com"), linkTarget("https://dashboard.gitguardian.com", base))
        assertEquals(LinkTarget.Open("http://host:4123/stats"), linkTarget("/stats", base))
        assertEquals(LinkTarget.Open("https://example.com"), linkTarget("example.com", base))
    }

    @Test fun `a run picks the failing job by default`() {
        val run = GhRun.of(
            Json.parseToJsonElement(
                """{"title":"t","workflow":"CI","status":"failed","url":"u","branch":"main","event":"push","attempt":2,
                "updatedAt":"2026-11-15T08:00:00Z","jobs":[
                  {"id":"1","name":"build","status":"passed","startedAt":"2026-11-15T08:00:00Z","completedAt":"2026-11-15T08:01:30Z","steps":[]},
                  {"id":"2","name":"test","status":"failed","steps":[{"name":"run","status":"failed"}]},
                  {"id":"3","name":"lint","status":"pending","steps":[]}]}""",
            ),
        )
        assertEquals(2, run.attempt)
        assertEquals("2", run.job(null)?.id)
        assertEquals("3", run.job("3")?.id)
        assertEquals("2", run.job("missing")?.id)
        assertEquals("1min", run.jobs[0].duration)
        assertEquals("", run.jobs[1].duration)
        assertEquals("1", run.copy(jobs = run.jobs.filter { it.status == "passed" }).job(null)?.id)
    }
}
