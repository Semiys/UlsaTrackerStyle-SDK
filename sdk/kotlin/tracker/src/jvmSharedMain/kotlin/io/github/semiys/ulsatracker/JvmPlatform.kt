package io.github.semiys.ulsatracker

import java.security.MessageDigest
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

internal actual fun newEventId(): String = UUID.randomUUID().toString()

internal actual fun retryAfterDate(value: String?, nowMillis: Long): Long =
    runCatching { ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - nowMillis }
        .getOrDefault(0).coerceIn(0, 7 * 86_400_000L)

internal fun queueIdentity(config: TrackerConfig): String =
    MessageDigest.getInstance("SHA-256").digest((config.endpoint.trimEnd('/') + "\n" + config.ingestKey).toByteArray()).joinToString("") { "%02x".format(it) }
