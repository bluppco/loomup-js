package com.loomup.client

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.atomic.AtomicBoolean

/** Injectable WebSocket used by realtime. Defaults to OkHttp WebSocket. */
interface WebSocketConnecting {
    var onOpen: (() -> Unit)?
    var onMessage: ((String) -> Unit)?
    var onClose: (() -> Unit)?
    /** True when the socket can send (OPEN). */
    val isOpen: Boolean
    /** True while connecting or open (CONNECTING | OPEN). */
    val isConnectingOrOpen: Boolean
    fun connect(url: String)
    fun send(text: String)
    fun close()
}

typealias WebSocketFactory = () -> WebSocketConnecting

/** Production WebSocket backed by OkHttp. */
class OkHttpWebSocketConnection(
    private val client: OkHttpClient = OkHttpClient(),
) : WebSocketConnecting {
    override var onOpen: (() -> Unit)? = null
    override var onMessage: ((String) -> Unit)? = null
    override var onClose: (() -> Unit)? = null

    private var webSocket: WebSocket? = null
    private val opened = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    private val connecting = AtomicBoolean(false)

    override val isOpen: Boolean
        get() = opened.get() && !closed.get()

    override val isConnectingOrOpen: Boolean
        get() = (connecting.get() || opened.get()) && !closed.get()

    override fun connect(url: String) {
        closed.set(false)
        opened.set(false)
        connecting.set(true)
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connecting.set(false)
                opened.set(true)
                onOpen?.invoke()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                onMessage?.invoke(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                onMessage?.invoke(bytes.utf8())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                markClosed()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                markClosed()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                markClosed()
            }
        })
    }

    override fun send(text: String) {
        if (isOpen) {
            webSocket?.send(text)
        }
    }

    override fun close() {
        closed.set(true)
        connecting.set(false)
        opened.set(false)
        webSocket?.close(1001, null)
        webSocket = null
    }

    private fun markClosed() {
        val already = closed.getAndSet(true)
        connecting.set(false)
        opened.set(false)
        webSocket = null
        if (!already) {
            onClose?.invoke()
        }
    }
}
