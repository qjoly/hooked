package dev.qjoly.hooked.state

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class ExportTest {
    @Test
    fun fencesOutgrowTheCode() {
        assertEquals("````\na ``` b\n````", codeFence("a ``` b"))
        assertEquals("`` `x` ``", inlineCode("`x`"))
        assertEquals("`plain`", inlineCode("plain"))
    }

    @Test
    fun conversationReadsLikeTheWebExport() {
        val c = Conversation.of(
            Json.parseToJsonElement(
                """
                {"id":"s1","title":"Fix it","project":"/p","model":"opus","startTs":"T0",
                 "messages":[
                  {"role":"user","ts":"T1","text":"go"},
                  {"role":"user","auto":true,"text":"wake"},
                  {"role":"assistant","ts":"T2","parts":[
                    {"type":"text","text":"Done."},
                    {"type":"tool","tool":{"name":"Bash","detail":"ls","inputText":"{}","result":"a"}}]},
                  {"role":"system","text":"compacted"}
                 ]}
                """,
            ),
        )
        val expected = """
            # Fix it

            - **Session**: `s1`
            - **Project**: /p
            - **Model**: opus
            - **Started**: T0

            ---
            ### 🧑 You · T1

            go

            ---

            ### ↻ Auto-resumed

            wake

            ---

            ### 🤖 Claude · T2

            Done.

            **🔧 Bash** — `ls`

            ```
            {}
            ```

            <details><summary>result</summary>

            ```
            a
            ```
            </details>

            ---

            > compacted

        """.trimIndent()
        assertEquals(expected, conversationMarkdown(c))
    }
}
