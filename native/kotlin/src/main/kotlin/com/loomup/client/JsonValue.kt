package com.loomup.client

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** Flexible JSON value for dynamic table rows (v1 has no schema codegen). */
@Serializable(with = JsonValueSerializer::class)
sealed class JsonValue {
    data object Null : JsonValue()
    data class Bool(val value: Boolean) : JsonValue()
    data class Number(val value: Double) : JsonValue()
    data class String(val value: kotlin.String) : JsonValue()
    data class Array(val value: List<JsonValue>) : JsonValue()
    data class Object(val value: Map<kotlin.String, JsonValue>) : JsonValue()

    val stringValue: kotlin.String?
        get() = (this as? String)?.value

    val boolValue: Boolean?
        get() = (this as? Bool)?.value

    val numberValue: Double?
        get() = (this as? Number)?.value

    val intValue: Int?
        get() = (this as? Number)?.value?.toInt()

    val longValue: Long?
        get() = (this as? Number)?.value?.toLong()

    val objectValue: Map<kotlin.String, JsonValue>?
        get() = (this as? Object)?.value

    val arrayValue: List<JsonValue>?
        get() = (this as? Array)?.value

    operator fun get(key: kotlin.String): JsonValue? = objectValue?.get(key)

    companion object {
        fun from(element: JsonElement?): JsonValue {
            if (element == null || element is JsonNull) return Null
            return when (element) {
                is JsonPrimitive -> {
                    if (element.isString) {
                        String(element.content)
                    } else {
                        element.booleanOrNull?.let { Bool(it) }
                            ?: element.longOrNull?.let { Number(it.toDouble()) }
                            ?: element.doubleOrNull?.let { Number(it) }
                            ?: String(element.content)
                    }
                }
                is JsonArray -> Array(element.map { from(it) })
                is JsonObject -> Object(element.mapValues { from(it.value) })
                else -> Null
            }
        }

        fun fromAny(any: Any?): JsonValue {
            return when (any) {
                null -> Null
                is Boolean -> Bool(any)
                is kotlin.Number -> Number(any.toDouble())
                is kotlin.String -> String(any)
                is List<*> -> Array(any.map { fromAny(it) })
                is Map<*, *> -> {
                    val map = linkedMapOf<kotlin.String, JsonValue>()
                    for ((k, v) in any) {
                        if (k is kotlin.String) map[k] = fromAny(v)
                    }
                    Object(map)
                }
                else -> String(any.toString())
            }
        }
    }

    fun toJsonElement(): JsonElement = when (this) {
        is Null -> JsonNull
        is Bool -> JsonPrimitive(value)
        is Number -> {
            if (value == value.toLong().toDouble() &&
                value >= Long.MIN_VALUE.toDouble() &&
                value <= Long.MAX_VALUE.toDouble()
            ) {
                JsonPrimitive(value.toLong())
            } else {
                JsonPrimitive(value)
            }
        }
        is String -> JsonPrimitive(value)
        is Array -> buildJsonArray { value.forEach { add(it.toJsonElement()) } }
        is Object -> buildJsonObject {
            value.forEach { (k, v) -> put(k, v.toJsonElement()) }
        }
    }
}

object JsonValueSerializer : KSerializer<JsonValue> {
    override val descriptor: SerialDescriptor =
        buildClassSerialDescriptor("JsonValue")

    override fun serialize(encoder: Encoder, value: JsonValue) {
        val jsonEncoder = encoder as? JsonEncoder
            ?: error("JsonValue can only be serialized to JSON")
        jsonEncoder.encodeJsonElement(value.toJsonElement())
    }

    override fun deserialize(decoder: Decoder): JsonValue {
        val jsonDecoder = decoder as? JsonDecoder
            ?: error("JsonValue can only be deserialized from JSON")
        return JsonValue.from(jsonDecoder.decodeJsonElement())
    }
}

/** Scalar filter value for `select(where=...)`. */
sealed class WhereValue {
    data class String(val value: kotlin.String) : WhereValue()
    data class Int(val value: kotlin.Int) : WhereValue()
    data class Long(val value: kotlin.Long) : WhereValue()
    data class Double(val value: kotlin.Double) : WhereValue()
    data class Bool(val value: Boolean) : WhereValue()
    data class Many(val values: kotlin.collections.List<WhereValue>) : WhereValue()

    /** Query-string form. Booleans become `"1"` / `"0"` to match SQLite storage. */
    val queryString: kotlin.String
        get() = when (this) {
            is String -> value
            is Int -> value.toString()
            is Long -> value.toString()
            is Double -> value.toString()
            is Bool -> if (value) "1" else "0"
            is Many -> values.joinToString(",") { it.queryString }
        }

    companion object {
        fun of(value: kotlin.String): WhereValue = String(value)
        fun of(value: kotlin.Int): WhereValue = Int(value)
        fun of(value: kotlin.Double): WhereValue = Double(value)
        fun of(value: Boolean): WhereValue = Bool(value)
        fun of(value: kotlin.Long): WhereValue = Long(value)
        fun many(vararg values: WhereValue): WhereValue = Many(values.toList())
    }
}
