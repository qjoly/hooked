package dev.qjoly.hooked.state

import dev.qjoly.hooked.data.Meta

// desktop's dnd.rs: dragging a session onto another groups them, onto a repo header takes it out.

sealed interface Drop {
    data class Session(val id: String) : Drop
    data object Detach : Drop
}

/** A drop target's box in root coordinates. */
data class DropBox(val x: Float, val y: Float, val w: Float, val h: Float) {
    fun contains(px: Float, py: Float) = px >= x && px < x + w && py >= y && py < y + h
    val area get() = w * h
}

/** Keys: `sb:<id>` / `fl:<id>` for a sidebar row or a fleet card, `repo:<name>` for a repo header. The smallest box under the point wins. */
fun hitDrop(boxes: Map<String, DropBox>, x: Float, y: Float, from: String): Drop? {
    val key = boxes.entries.filter { it.value.contains(x, y) }.minByOrNull { it.value.area }?.key ?: return null
    if (key.startsWith("repo:")) return Drop.Detach
    val id = key.removePrefix("sb:").removePrefix("fl:").takeIf { it != key } ?: return null
    return if (id != from) Drop.Session(id) else null
}

fun groupOf(id: String, meta: Map<String, Meta>) = meta.of(id).groupOf?.takeIf { it != id }

fun leadOf(id: String, meta: Map<String, Meta>) = groupOf(id, meta) ?: id

/** Whether dropping changes anything: joining another group, or leaving one. */
fun dropAllowed(id: String, drop: Drop, meta: Map<String, Meta>) = when (drop) {
    is Drop.Session -> leadOf(drop.id, meta) != leadOf(id, meta)
    Drop.Detach -> groupOf(id, meta) != null
}

/** Whether the target under `key` is the one the drag hovers. */
fun dropHot(key: String, over: Drop?) = when (over) {
    null -> false
    is Drop.Session -> key == "sb:${over.id}" || key == "fl:${over.id}"
    Drop.Detach -> key.startsWith("repo:")
}
