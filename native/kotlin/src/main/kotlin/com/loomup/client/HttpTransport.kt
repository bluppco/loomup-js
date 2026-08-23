package com.loomup.client

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray? = null,
)

data class HttpResponse(
    val status: Int,
    val body: ByteArray,
)

/** Injectable HTTP transport (defaults to OkHttp). */
fun interface HttpTransport {
    suspend fun execute(request: HttpRequest): HttpResponse
}

class OkHttpHttpTransport(
    private val client: OkHttpClient = OkHttpClient(),
) : HttpTransport {
    override suspend fun execute(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(request.url)
        for ((k, v) in request.headers) {
            builder.header(k, v)
        }
        val body = request.body
        // Prefer explicit Content-Type header (binary storage uploads) over JSON default.
        val contentTypeHeader = request.headers.entries
            .firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }
            ?.value
        val mediaType = (contentTypeHeader ?: "application/json; charset=utf-8").toMediaType()
        when (request.method.uppercase()) {
            "GET" -> builder.get()
            "DELETE" -> {
                if (body != null) {
                    builder.delete(body.toRequestBody(mediaType))
                } else {
                    builder.delete()
                }
            }
            "POST" -> builder.post((body ?: ByteArray(0)).toRequestBody(mediaType))
            "PATCH" -> builder.patch((body ?: ByteArray(0)).toRequestBody(mediaType))
            "PUT" -> builder.put((body ?: ByteArray(0)).toRequestBody(mediaType))
            else -> {
                if (body != null) {
                    builder.method(request.method, body.toRequestBody(mediaType))
                } else {
                    builder.method(request.method, null)
                }
            }
        }
        client.newCall(builder.build()).execute().use { response ->
            HttpResponse(
                status = response.code,
                body = response.body?.bytes() ?: ByteArray(0),
            )
        }
    }
}
