package dev.qjoly.hooked.state

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.edit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The session view's lenses, keyed as rune's number keys. */
enum class Lens(val key: String) { CONVERSE("1"), REVIEW("3"), MCP("4"), TRACE("5") }

/** What the session view keeps across sessions: the lens, the dock, the drafts, the splits. Drafts and the dock survive a restart. */
class SessionUi private constructor(ctx: Context) {
    private val sp = ctx.getSharedPreferences("session-ui", Context.MODE_PRIVATE)

    var lens by mutableStateOf(Lens.CONVERSE)
    var dockOpen by mutableStateOf(sp.getBoolean("dockOpen", true))
        private set
    var focus by mutableStateOf(false)
    var allToolsOpen by mutableStateOf(false)
    var termOpen by mutableStateOf(false)

    /** Split panes beside the main one, at most three. */
    val splits = mutableStateListOf<String>()

    private var drafts: Map<String, String> = runCatching {
        Json.parseToJsonElement(sp.getString("drafts", "{}")!!).jsonObject.mapValues { it.value.jsonPrimitive.content }
    }.getOrDefault(emptyMap())

    fun toggleDock() {
        dockOpen = !dockOpen
        sp.edit { putBoolean("dockOpen", dockOpen) }
    }

    fun draft(id: String) = drafts[id].orEmpty()

    fun saveDraft(id: String, text: String) {
        val t = text.trimEnd()
        val next = if (t.isEmpty()) drafts - id else drafts + (id to t)
        if (next == drafts) return
        drafts = next
        sp.edit { putString("drafts", JsonObject(next.mapValues { JsonPrimitive(it.value) }).toString()) }
    }

    /** A fourth pane replaces the last. */
    fun openSplit(id: String, main: String) {
        if (id == main || id in splits) return
        if (splits.size >= MAX_SPLITS) splits.removeAt(splits.lastIndex)
        splits += id
    }

    companion object {
        const val MAX_SPLITS = 3

        @Volatile
        private var instance: SessionUi? = null

        fun of(ctx: Context): SessionUi = instance ?: synchronized(this) {
            instance ?: SessionUi(ctx.applicationContext).also { instance = it }
        }
    }
}
