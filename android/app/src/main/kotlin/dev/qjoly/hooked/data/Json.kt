package dev.qjoly.hooked.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant
import java.time.OffsetDateTime

// Lenient reads, as in the iOS app: a missing or mistyped field never fails a decode.

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

private val JsonElement?.prim: JsonPrimitive? get() = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }

val JsonElement?.str: String? get() = prim?.content

/** Non-empty string, or null. */
val JsonElement?.text: String? get() = str?.takeIf { it.isNotEmpty() }

val JsonElement?.dbl: Double? get() = prim?.doubleOrNull

val JsonElement?.int: Int? get() = dbl?.toInt()

val JsonElement?.bool: Boolean
    get() = prim?.let { it.booleanOrNull ?: it.doubleOrNull?.let { d -> d != 0.0 } ?: (it.content == "1") } ?: false

val JsonElement?.arr: List<JsonElement> get() = (this as? JsonArray) ?: emptyList()

val JsonElement?.obj: JsonObject? get() = this as? JsonObject

/** ISO-8601 or epoch seconds/milliseconds, as epoch milliseconds. */
val JsonElement?.millis: Long?
    get() {
        val p = prim ?: return null
        p.doubleOrNull?.let { return if (it > 1e11) it.toLong() else (it * 1000).toLong() }
        return runCatching { Instant.parse(p.content).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(p.content).toInstant().toEpochMilli() }.getOrNull()
    }

/** A JSON object without its null entries, for request bodies. */
fun body(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(
    pairs.mapNotNull { (k, v) ->
        when (v) {
            null -> null
            is JsonElement -> k to v
            is String -> k to JsonPrimitive(v)
            is Boolean -> k to JsonPrimitive(v)
            is Number -> k to JsonPrimitive(v)
            is List<*> -> k to JsonArray(v.map { (it as? JsonElement) ?: JsonPrimitive(it?.toString()) })
            else -> k to JsonPrimitive(v.toString())
        }
    }.toMap(),
)
