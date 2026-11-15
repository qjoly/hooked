package dev.qjoly.hooked.state

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.edit
import dev.qjoly.hooked.ui.kit.Appearance
import dev.qjoly.hooked.ui.kit.Corners
import dev.qjoly.hooked.ui.kit.Scheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** What rune keeps per device: look, sidebar layout, pins, renames and the like. Each change is saved at once. */
class UiPrefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    private fun str(key: String, def: String) = sp.getString(key, def) ?: def
    private fun set(key: String) = runCatching { Json.parseToJsonElement(sp.getString(key, "[]")!!).jsonArray.map { it.jsonPrimitive.content }.toSet() }.getOrDefault(emptySet())
    private fun strMap(key: String) = runCatching { Json.parseToJsonElement(sp.getString(key, "{}")!!).jsonObject.mapValues { it.value.jsonPrimitive.content } }.getOrDefault(emptyMap())
    private fun intMap(key: String) = runCatching { Json.parseToJsonElement(sp.getString(key, "{}")!!).jsonObject.mapValues { it.value.jsonPrimitive.int } }.getOrDefault(emptyMap())

    var scheme by mutableStateOf(Scheme.of(sp.getString("scheme", null))); private set
    var appearance by mutableStateOf(Appearance.of(sp.getString("appearance", null))); private set
    var corners by mutableStateOf(Corners.of(sp.getString("corners", null))); private set
    var uiScale by mutableStateOf(sp.getFloat("uiScale", 1f)); private set
    var sidebarLayout by mutableStateOf(str("sidebarLayout", "status")); private set
    var sortMode by mutableStateOf(str("sortMode", "dynamic")); private set
    var hideOld by mutableStateOf(sp.getBoolean("hideOld", false)); private set
    var sidebarOpen by mutableStateOf(sp.getBoolean("sidebarOpen", true)); private set
    var sidebarW by mutableStateOf(sp.getFloat("sidebarW", 300f)); private set
    var deckView by mutableStateOf(str("deckView", "grid")); private set
    var incognito by mutableStateOf(sp.getBoolean("incognito", false)); private set
    var pinned by mutableStateOf(set("pinned")); private set
    var foldedGroups by mutableStateOf(set("foldedGroups")); private set
    var names by mutableStateOf(strMap("names")); private set
    var tagColors by mutableStateOf(intMap("tagColors")); private set
    var collapseWorktrees by mutableStateOf(sp.getBoolean("collapseWorktrees", true)); private set
    var termFont by mutableStateOf(sp.getFloat("termFont", 12f)); private set

    fun scheme(v: Scheme) { scheme = v; sp.edit { putString("scheme", v.key) } }
    fun appearance(v: Appearance) { appearance = v; sp.edit { putString("appearance", v.key) } }
    fun corners(v: Corners) { corners = v; sp.edit { putString("corners", v.key) } }
    fun uiScale(v: Float) { uiScale = v; sp.edit { putFloat("uiScale", v) } }
    fun sidebarLayout(v: String) { sidebarLayout = v; sp.edit { putString("sidebarLayout", v) } }
    fun sortMode(v: String) { sortMode = v; sp.edit { putString("sortMode", v) } }
    fun hideOld(v: Boolean) { hideOld = v; sp.edit { putBoolean("hideOld", v) } }
    fun sidebarOpen(v: Boolean) { sidebarOpen = v; sp.edit { putBoolean("sidebarOpen", v) } }
    fun sidebarW(v: Float) { sidebarW = v.coerceIn(220f, 560f); sp.edit { putFloat("sidebarW", sidebarW) } }
    fun deckView(v: String) { deckView = v; sp.edit { putString("deckView", v) } }
    fun incognito(v: Boolean) { incognito = v; sp.edit { putBoolean("incognito", v) } }
    fun collapseWorktrees(v: Boolean) { collapseWorktrees = v; sp.edit { putBoolean("collapseWorktrees", v) } }
    fun termFont(v: Float) { termFont = v.coerceIn(8f, 28f); sp.edit { putFloat("termFont", termFont) } }

    fun togglePin(id: String) {
        pinned = if (id in pinned) pinned - id else pinned + id
        sp.edit { putString("pinned", JsonArray(pinned.map(::JsonPrimitive)).toString()) }
    }

    fun toggleFold(id: String) {
        foldedGroups = if (id in foldedGroups) foldedGroups - id else foldedGroups + id
        sp.edit { putString("foldedGroups", JsonArray(foldedGroups.map(::JsonPrimitive)).toString()) }
    }

    /** An empty name, or one equal to the server title, clears the local rename. */
    fun rename(id: String, name: String?) {
        names = if (name.isNullOrBlank()) names - id else names + (id to name.take(120))
        sp.edit { putString("names", JsonObject(names.mapValues { JsonPrimitive(it.value) }).toString()) }
    }

    fun tagColor(tag: String, index: Int?) {
        tagColors = if (index == null) tagColors - tag else tagColors + (tag to index)
        sp.edit { putString("tagColors", JsonObject(tagColors.mapValues { JsonPrimitive(it.value) }).toString()) }
    }
}
