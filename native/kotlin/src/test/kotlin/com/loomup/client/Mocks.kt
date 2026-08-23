package com.loomup.client

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

// MARK: - HTTP mock

class MockHttp : HttpTransport {
    data class Call(
        val method: String,
        val url: String,
        val auth: String?,
        val body: ByteArray?,
    )

    private val calls = CopyOnWriteArrayList<Call>()
    var handler: (suspend (method: String, url: String, auth: String?, body: ByteArray?) -> Pair<ByteArray, Int>)? =
        null

    override suspend fun execute(request: HttpRequest): HttpResponse {
        val auth = request.headers["Authorization"]
        calls.add(Call(request.method, request.url, auth, request.body))
        val h = handler ?: throw LoomupError("no mock handler", code = "test")
        val (data, status) = h(request.method, request.url, auth, request.body)
        return HttpResponse(status = status, body = data)
    }

    fun snapshotCalls(): List<Call> = calls.toList()
}

fun jsonBytes(json: String): ByteArray = json.toByteArray(StandardCharsets.UTF_8)

// MARK: - WebSocket mock

class MockWebSocket : WebSocketConnecting {
    override var onOpen: (() -> Unit)? = null
    override var onMessage: ((String) -> Unit)? = null
    override var onClose: (() -> Unit)? = null

    private val sent = CopyOnWriteArrayList<String>()
    private val _isOpen = AtomicBoolean(false)
    private val _connecting = AtomicBoolean(false)
    private val connectCount = AtomicInteger(0)

    var openDelayMs: Long = 0
    /** If false, stay CONNECTING forever (for timeout tests). */
    var autoOpen: Boolean = true
    /** Optional hook after each outbound frame. */
    var onSend: ((String) -> Unit)? = null

    override val isOpen: Boolean
        get() = _isOpen.get()

    override val isConnectingOrOpen: Boolean
        get() = _connecting.get() || _isOpen.get()

    val connectCountValue: Int
        get() = connectCount.get()

    override fun connect(url: String) {
        connectCount.incrementAndGet()
        _connecting.set(true)
        _isOpen.set(false)
        if (!autoOpen) return
        if (openDelayMs <= 0) {
            simulateOpen()
        } else {
            Thread {
                Thread.sleep(openDelayMs)
                simulateOpen()
            }.start()
        }
    }

    override fun send(text: String) {
        sent.add(text)
        onSend?.invoke(text)
    }

    override fun close() {
        _isOpen.set(false)
        _connecting.set(false)
        onClose?.invoke()
    }

    fun simulateOpen() {
        _isOpen.set(true)
        _connecting.set(false)
        onOpen?.invoke()
    }

    fun simulateMessage(text: String) {
        onMessage?.invoke(text)
    }

    fun simulateClose() {
        _isOpen.set(false)
        _connecting.set(false)
        onClose?.invoke()
    }

    fun snapshotSent(): List<String> = sent.toList()

    fun clearSent() {
        sent.clear()
    }

    fun parsedSent(): List<JsonObject> {
        val json = Json { ignoreUnknownKeys = true }
        return snapshotSent().mapNotNull { text ->
            try {
                json.parseToJsonElement(text).jsonObject
            } catch (_: Exception) {
                null
            }
        }
    }
}

/** Holds the latest mock socket so tests can drive messages after connect. */
class MockWebSocketBox {
    private val current = AtomicReference<MockWebSocket?>(null)
    var autoOpen: Boolean = true
    var openDelayMs: Long = 0

    fun note(ws: MockWebSocket) {
        current.set(ws)
    }

    fun factory(): WebSocketFactory = {
        val ws = MockWebSocket()
        ws.autoOpen = autoOpen
        ws.openDelayMs = openDelayMs
        note(ws)
        ws
    }

    val socket: MockWebSocket?
        get() = current.get()
}
