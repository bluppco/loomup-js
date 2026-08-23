package com.loomup.client

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID

/** Join base URL with a path (path may be absolute-looking `/api/...`). */
fun joinUrl(base: String, path: String): String {
    val trimmed = base.trimEnd('/')
    val p = if (path.startsWith("/")) path else "/$path"
    return trimmed + p
}

/**
 * Subscription keys are `table` or `table#rowId`. Split only on the first `#`
 * so row IDs that themselves contain `#` round-trip correctly.
 */
fun parseSubKey(key: String): Pair<String, String?> {
    val idx = key.indexOf('#')
    return if (idx == -1) {
        key to null
    } else {
        key.substring(0, idx) to key.substring(idx + 1)
    }
}

fun makeSubKey(table: String, rowId: String? = null): String {
    return if (rowId != null && rowId.isNotEmpty()) {
        "$table#$rowId"
    } else {
        table
    }
}

@PublishedApi
internal fun encodeURIComponent(value: String): String {
    return URLEncoder.encode(value, StandardCharsets.UTF_8.name())
        .replace("+", "%20")
        .replace("%7E", "~")
}

internal fun realtimeWebSocketUrl(httpBase: String): String {
    val trimmed = httpBase.trimEnd('/')
    val wsBase = when {
        trimmed.startsWith("https://", ignoreCase = true) ->
            "wss://" + trimmed.removePrefix("https://").removePrefix("HTTPS://")
        trimmed.startsWith("http://", ignoreCase = true) ->
            "ws://" + trimmed.removePrefix("http://").removePrefix("HTTP://")
        else -> trimmed
    }
    return "$wsBase/realtime"
}

internal fun unixSecondsNow(): Long = System.currentTimeMillis() / 1000

internal fun makeRequestId(table: String): String {
    val rand = UUID.randomUUID().toString().take(8).lowercase()
    return "sub_${table}_${System.currentTimeMillis()}_$rand"
}

internal fun stringifyId(value: Any?): String {
    return when (value) {
        null -> ""
        is String -> value
        is Number -> {
            val d = value.toDouble()
            if (d == d.toLong().toDouble()) value.toLong().toString() else value.toString()
        }
        is Boolean -> if (value) "1" else "0"
        else -> value.toString()
    }
}
