package com.loomup.client

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class RealtimeTest {
    @Test
    fun injectedWebSocketConstructedOnSubscribe() = runBlocking {
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://localhost:3000",
            webSocketFactory = box.factory(),
        )
        // No socket until subscribe
        val unsub = c.from("todos").subscribe { }
        delay(50)
        assertNotNull(box.socket)
        assertEquals(1, box.socket!!.connectCountValue)
        unsub()
        c.closeRealtime()
    }

    @Test
    fun controlErrorFramesSurfaceWithCode() = runBlocking {
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://localhost:3000",
            webSocketFactory = box.factory(),
        )
        val controls = mutableListOf<ControlEvent>()
        val off = c.onControl { controls.add(it) }
        val unsub = c.from("todos").subscribe { }
        delay(50)
        box.socket?.simulateMessage(
            """{"type":"error","code":"AUTH_ERROR","message":"invalid or expired token"}""",
        )
        box.socket?.simulateMessage(
            """{"type":"error","code":"SUBSCRIBE_ERROR","table":"todos","message":"subscribe forbidden"}""",
        )
        delay(20)
        assertTrue(controls.any { it.type == "error" && it.code == "AUTH_ERROR" })
        assertTrue(controls.any { it.type == "error" && it.code == "SUBSCRIBE_ERROR" })
        off()
        unsub()
        c.closeRealtime()
    }

    @Test
    fun setTokenReauthsAndResubscribes() = runBlocking {
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://localhost:3000",
            token = "old-token",
            webSocketFactory = box.factory(),
        )
        val unsub = c.from("todos").subscribe(rowId = "1") { }
        delay(50)
        box.socket?.clearSent()
        c.setToken("new-token")
        delay(20)
        val frames = box.socket?.parsedSent().orEmpty()
        assertTrue(
            frames.any {
                it["type"]?.jsonPrimitive?.contentOrNull == "auth" &&
                    it["token"]?.jsonPrimitive?.contentOrNull == "new-token"
            },
            frames.toString(),
        )
        assertTrue(
            frames.any {
                it["type"]?.jsonPrimitive?.contentOrNull == "subscribe" &&
                    it["token"]?.jsonPrimitive?.contentOrNull == "new-token"
            },
            frames.toString(),
        )
        unsub()
        c.closeRealtime()
    }

    @Test
    fun rowUnsubSendsId() = runBlocking {
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://localhost:3000",
            webSocketFactory = box.factory(),
        )
        val u1 = c.from("todos").subscribe(rowId = "1") { }
        val u2 = c.from("todos").subscribe(rowId = "2") { }
        delay(40)
        u1()
        delay(20)
        val unsubs = (box.socket?.parsedSent().orEmpty())
            .filter { it["type"]?.jsonPrimitive?.contentOrNull == "unsubscribe" }
        assertTrue(
            unsubs.any { it["id"]?.jsonPrimitive?.contentOrNull == "1" },
            unsubs.toString(),
        )
        u2()
        c.closeRealtime()
    }

    @Test
    fun subscribeWithHashInRowId() = runBlocking {
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://localhost:3000",
            token = "tok1",
            webSocketFactory = box.factory(),
        )
        val rowId = "prefix#with#hashes"
        val unsub = c.from("items").subscribe(rowId = rowId) { }
        delay(50)
        val subs = (box.socket?.parsedSent().orEmpty())
            .filter { it["type"]?.jsonPrimitive?.contentOrNull == "subscribe" }
        assertTrue(
            subs.any {
                it["id"]?.jsonPrimitive?.contentOrNull == rowId &&
                    it["table"]?.jsonPrimitive?.contentOrNull == "items"
            },
            subs.toString(),
        )
        unsub()
        c.closeRealtime()
    }

    @Test
    fun refreshApplyTokensSendsAuthAndResubscribe() = runBlocking {
        val http = MockHttp()
        http.handler = { _, url, _, _ ->
            if (url.endsWith("/auth/refresh")) {
                val body = """
                    {
                      "data": {
                        "access_token": "rotated-access",
                        "refresh_token": "rotated-refresh",
                        "token_type": "Bearer",
                        "expires_in": 900
                      }
                    }
                """.trimIndent()
                jsonBytes(body) to 200
            } else {
                jsonBytes("nope") to 500
            }
        }
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://example.test",
            token = "old-access",
            refreshToken = "r1",
            http = http,
            webSocketFactory = box.factory(),
        )
        val unsub = c.from("todos").subscribe(rowId = "42") { }
        delay(50)
        if (box.socket?.isOpen != true) {
            box.socket?.simulateOpen()
        }
        box.socket?.clearSent()
        c.refresh()
        assertEquals("rotated-access", c.accessToken)
        delay(30)
        val frames = box.socket?.parsedSent().orEmpty()
        assertTrue(
            frames.any {
                it["type"]?.jsonPrimitive?.contentOrNull == "auth" &&
                    it["token"]?.jsonPrimitive?.contentOrNull == "rotated-access"
            },
            frames.toString(),
        )
        assertTrue(
            frames.any {
                it["type"]?.jsonPrimitive?.contentOrNull == "subscribe" &&
                    it["token"]?.jsonPrimitive?.contentOrNull == "rotated-access" &&
                    it["table"]?.jsonPrimitive?.contentOrNull == "todos" &&
                    it["id"]?.jsonPrimitive?.contentOrNull == "42"
            },
            frames.toString(),
        )
        unsub()
        c.closeRealtime()
    }

    @Test
    fun reconnectResyncDeliversResyncEvents() = runBlocking {
        val http = MockHttp()
        http.handler = { _, url, _, _ ->
            if (url.contains("/api/todos/7")) {
                jsonBytes("""{"data":{"id":7,"title":"after-outage"}}""") to 200
            } else {
                jsonBytes("nope") to 404
            }
        }
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://example.test",
            token = "t",
            http = http,
            webSocketFactory = box.factory(),
        )
        val events = mutableListOf<ChangeEvent>()
        val unsub = c.from("todos").subscribe(rowId = "7") { events.add(it) }
        delay(50)
        assertEquals(0, events.count { it.op == "RESYNC" })

        // Drop + reconnect
        box.socket?.simulateClose()
        // Wait for reconnect timer (min ~50ms, jitter up to 1s first attempt)
        delay(1300)

        val resyncs = events.filter { it.op == "RESYNC" }
        assertTrue(resyncs.isNotEmpty(), "events=${events.map { it.op }}")
        val first = resyncs.first()
        assertEquals("7", first.id)
        assertEquals("after-outage", first.data?.get("title")?.stringValue)
        unsub()
        c.closeRealtime()
    }

    @Test
    fun subscribeReadyAwaitsSubscribedAck() = runBlocking {
        val box = MockWebSocketBox()
        val factory: WebSocketFactory = {
            val ws = MockWebSocket()
            ws.onSend = { text ->
                try {
                    val json = kotlinx.serialization.json.Json.parseToJsonElement(text).jsonObjectOrNull()
                    if (json?.get("type")?.jsonPrimitive?.contentOrNull == "subscribe") {
                        val rid = json["requestId"]?.jsonPrimitive?.contentOrNull
                        if (rid != null) {
                            val ack =
                                """{"type":"subscribed","requestId":"$rid","table":"todos","channel":"todos"}"""
                            Thread {
                                Thread.sleep(5)
                                ws.simulateMessage(ack)
                            }.start()
                        }
                    }
                } catch (_: Exception) {
                }
            }
            box.note(ws)
            ws
        }
        val c = createClient(
            url = "http://example.test",
            webSocketFactory = factory,
        )
        val unsub = c.from("todos").subscribeReady { }
        unsub()
        c.closeRealtime()
    }

    @Test
    fun subscribeReadyTimeoutCleansUp() = runBlocking {
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://example.test",
            webSocketFactory = box.factory(),
        )
        val e = assertFailsWith<LoomupError> {
            c.from("todos").subscribeReady(timeoutMs = 80) { }
        }
        assertTrue(
            e.message!!.contains("timeout") || e.code == "subscribe_timeout",
            e.message,
        )
        c.closeRealtime()
    }

    @Test
    fun subscribeReadyRejectsOnErrorFrame() = runBlocking {
        val box = MockWebSocketBox()
        val factory: WebSocketFactory = {
            val ws = MockWebSocket()
            ws.onSend = { text ->
                try {
                    val json = kotlinx.serialization.json.Json.parseToJsonElement(text).jsonObjectOrNull()
                    if (json?.get("type")?.jsonPrimitive?.contentOrNull == "subscribe") {
                        val rid = json["requestId"]?.jsonPrimitive?.contentOrNull
                        if (rid != null) {
                            val err =
                                """{"type":"error","code":"SUBSCRIBE_ERROR","requestId":"$rid","message":"table not exposed or realtime disabled"}"""
                            Thread {
                                Thread.sleep(5)
                                ws.simulateMessage(err)
                            }.start()
                        }
                    }
                } catch (_: Exception) {
                }
            }
            box.note(ws)
            ws
        }
        val c = createClient(
            url = "http://example.test",
            webSocketFactory = factory,
        )
        val e = assertFailsWith<LoomupError> {
            c.from("todos").subscribeReady(timeoutMs = 2000) { }
        }
        assertTrue(
            e.message!!.contains("table not exposed") ||
                e.code == "SUBSCRIBE_ERROR" ||
                e.message!!.contains("subscribe"),
            e.message,
        )
        c.closeRealtime()
    }

    @Test
    fun changeEventFanout() = runBlocking {
        val box = MockWebSocketBox()
        val c = createClient(
            url = "http://example.test",
            webSocketFactory = box.factory(),
        )
        val tableEvents = mutableListOf<ChangeEvent>()
        val rowEvents = mutableListOf<ChangeEvent>()
        val u1 = c.from("todos").subscribe { tableEvents.add(it) }
        val u2 = c.from("todos").subscribe(rowId = "9") { rowEvents.add(it) }
        delay(40)
        box.socket?.simulateMessage(
            """{"type":"change","table":"todos","op":"INSERT","id":"9","data":{"id":9,"title":"x"},"ts":100}""",
        )
        delay(20)
        assertEquals(1, tableEvents.size)
        assertEquals(1, rowEvents.size)
        assertEquals("INSERT", tableEvents.first().op)
        u1()
        u2()
        c.closeRealtime()
    }
}

private fun kotlinx.serialization.json.JsonElement.jsonObjectOrNull():
    kotlinx.serialization.json.JsonObject? =
    this as? kotlinx.serialization.json.JsonObject
