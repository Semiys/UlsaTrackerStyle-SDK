package io.github.semiys.ulsatracker

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal val trackerJson = Json { encodeDefaults = true }
internal val eventName = Regex("[a-z][a-z0-9_]{0,63}")

@Serializable
internal data class TrackerEvent(
    val eventId: String,
    val sessionId: String,
    val occurredAt: String,
    val name: String,
    val screen: String?,
    val platform: String,
    val appVersion: String,
    val properties: JsonObject,
)

@Serializable
internal data class EventBatch(val schemaVersion: Int = 1, val events: List<TrackerEvent>)

@Serializable
internal data class QueueState(
    val schemaVersion: Int = 1,
    val enabled: Boolean = true,
    val dropped: Long = 0,
    val rejected: Long = 0,
    val events: List<TrackerEvent> = emptyList(),
)

internal fun encodeProperties(values: Map<String, Any?>): JsonObject {
    require(values.size <= 16)
    val result = JsonObject(values.mapValues { (key, value) ->
        require(eventName.matches(key) && key !in listOf("__proto__", "constructor", "prototype"))
        when (value) {
            null -> JsonNull
            is String -> { require(value.length <= 256); JsonPrimitive(value) }
            is Boolean -> JsonPrimitive(value)
            is Byte, is Short, is Int, is Long -> JsonPrimitive(value as Number)
            is Float -> { require(value.isFinite()); JsonPrimitive(value) }
            is Double -> { require(value.isFinite()); JsonPrimitive(value) }
            else -> error("Only scalar event properties are supported")
        }
    })
    require(trackerJson.encodeToString(result).encodeToByteArray().size <= 4_096)
    return result
}
