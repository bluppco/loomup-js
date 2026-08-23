package com.loomup.client

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/** Loomup Realtime client: REST + WebSocket subscriptions. */
class LoomupClient(options: LoomupClientOptions) {
    val url: String

    private val http: HttpTransport
    private val webSocketFactory: WebSocketFactory
    private val lock = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var token: String? = null

    @Volatile
    private var refreshToken: String? = null

    private val publishableKey: String?
    private val serviceKey: String?

    // Realtime state
    private var ws: WebSocketConnecting? = null
    private val subs = ConcurrentHashMap<String, ConcurrentHashMap<String, SubscribeHandler>>()
    private val controlHandlers = ConcurrentHashMap<String, ControlHandler>()
    private val pendingSubscribeAcks = ConcurrentHashMap<String, PendingAck>()
    private var reconnectJob: Job? = null

    @Volatile
    private var intentionalClose = false

    @Volatile
    private var hasOpenedOnce = false

    @Volatile
    private var reconnectAttempt = 0

    private val tablePrimaryKeys = ConcurrentHashMap<String, String>()
    private var refreshingDeferred: CompletableDeferred<AuthTokens>? = null

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        isLenient = true
    }

    private data class PendingAck(
        val deferred: CompletableDeferred<Unit>,
        val timeoutJob: Job,
    )

    init {
        url = options.url.trimEnd('/')
        token = options.token
        refreshToken = options.refreshToken
        publishableKey = options.publishableKey
        serviceKey = options.serviceKey
        http = options.http
        webSocketFactory = options.webSocketFactory ?: { OkHttpWebSocketConnection() }
    }

    // MARK: - Tokens

    val accessToken: String?
        get() = token

    fun setToken(token: String?) {
        this.token = token
        reauthAndResubscribe()
    }

    fun setRefreshToken(token: String?) {
        this.refreshToken = token
    }

    fun setTablePrimaryKey(table: String, pk: String) {
        tablePrimaryKeys[table] = pk
    }

    // MARK: - Auth surface

    val auth: AuthAPI = AuthAPI(this)
    val push: PushAPI = PushAPI(this)
    val storage: StorageAPI = StorageAPI(this)

    class AuthAPI internal constructor(private val client: LoomupClient) {
        suspend fun signUp(email: String, password: String): AuthTokens =
            client.signUp(email, password)

        suspend fun register(email: String, password: String): AuthTokens =
            signUp(email, password)

        suspend fun signIn(email: String, password: String): AuthTokens =
            client.signIn(email, password)

        suspend fun login(email: String, password: String): AuthTokens =
            signIn(email, password)

        suspend fun signOut() = client.signOut()

        suspend fun logout() = signOut()

        suspend fun me(): User = client.me()

        suspend fun refresh(): AuthTokens = client.refresh()
    }

    class PushAPI internal constructor(private val client: LoomupClient) {
        suspend fun registerDevice(
            token: String,
            provider: String,
            platform: String? = null,
            deviceId: String? = null,
            appVersion: String? = null,
            locale: String? = null,
        ): PushDevice = client.registerPushDevice(
            token = token,
            provider = provider,
            platform = platform,
            deviceId = deviceId,
            appVersion = appVersion,
            locale = locale,
        )

        suspend fun listDevices(): List<PushDevice> = client.listPushDevices()

        suspend fun unregisterDevice(id: String? = null, token: String? = null) =
            client.unregisterPushDevice(id = id, token = token)
    }

    class StorageAPI internal constructor(private val client: LoomupClient) {
        suspend fun listBuckets(): List<StorageBucketInfo> = client.listStorageBuckets()

        fun from(bucket: String): StorageBucket = StorageBucket(client, bucket)
    }

    class StorageBucket internal constructor(
        private val client: LoomupClient,
        val bucket: String,
    ) {
        private fun objectPath(path: String): String {
            val encoded = path.split("/").joinToString("/") { encodeURIComponent(it) }
            return "/storage/v1/${encodeURIComponent(bucket)}/object/$encoded"
        }

        suspend fun upload(
            path: String,
            data: ByteArray,
            contentType: String? = "application/octet-stream",
            upsert: Boolean = false,
        ): StorageObject {
            val headers = linkedMapOf<String, String>()
            if (contentType != null) headers["Content-Type"] = contentType
            if (upsert) headers["x-loomup-upsert"] = "true"
            val env = client.requestJson<DataEnvelope<StorageObject>>(
                method = "POST",
                path = objectPath(path),
                body = data,
                contentType = contentType,
                extraHeaders = headers,
            )
            return env.data
        }

        suspend fun download(path: String): ByteArray =
            client.request(
                method = "GET",
                path = objectPath(path),
                body = null,
                contentType = null,
                extraHeaders = mapOf("Accept" to "*/*"),
            )

        suspend fun list(
            prefix: String? = null,
            limit: Int = 100,
            offset: Int = 0,
        ): Pair<List<StorageObject>, ListMeta> {
            val q = buildString {
                append("limit=$limit&offset=$offset")
                if (prefix != null) append("&prefix=${encodeURIComponent(prefix)}")
            }
            val env = client.requestJson<StorageListEnvelope>(
                method = "GET",
                path = "/storage/v1/${encodeURIComponent(bucket)}?$q",
            )
            return env.data to env.meta
        }

        suspend fun remove(path: String): StorageObject {
            val env = client.requestJson<DataEnvelope<StorageObject>>(
                method = "DELETE",
                path = objectPath(path),
            )
            return env.data
        }
    }

    suspend fun listStorageBuckets(): List<StorageBucketInfo> {
        val env = requestJson<DataEnvelope<List<StorageBucketInfo>>>(
            method = "GET",
            path = "/storage/v1/buckets",
        )
        return env.data
    }

    fun from(table: String): TableQuery = TableQuery(this, table)

    // MARK: - Control handlers

    fun onControl(handler: ControlHandler): Unsubscribe {
        val id = UUID.randomUUID().toString()
        controlHandlers[id] = handler
        return {
            controlHandlers.remove(id)
        }
    }

    // MARK: - HTTP

    suspend fun request(
        method: String,
        path: String,
        body: ByteArray? = null,
        contentType: String? = "application/json",
        extraHeaders: Map<String, String> = emptyMap(),
        skipRetry: Boolean = false,
    ): ByteArray {
        val access = token
        val refresh = refreshToken
        val headers = linkedMapOf(
            "Accept" to "application/json",
        )
        headers.putAll(extraHeaders)
        if (access != null) {
            headers["Authorization"] = "Bearer $access"
        } else if (serviceKey != null) {
            headers["Authorization"] = "Bearer $serviceKey"
        }
        if (publishableKey != null) {
            headers["X-Loomup-Key"] = publishableKey
        }
        if (body != null && contentType != null) {
            headers["Content-Type"] = contentType
        }

        val response = http.execute(
            HttpRequest(
                method = method,
                url = joinUrl(url, path),
                headers = headers,
                body = body,
            ),
        )

        if (response.status == 401 &&
            !skipRetry &&
            refresh != null &&
            path != "/auth/refresh" &&
            path != "/auth/login" &&
            path != "/auth/register"
        ) {
            try {
                refresh()
                return request(
                    method,
                    path,
                    body,
                    contentType = contentType,
                    extraHeaders = extraHeaders,
                    skipRetry = true,
                )
            } catch (_: Exception) {
                // fall through with original error
            }
        }

        if (response.status !in 200..299) {
            throw parseError(response.body, response.status)
        }
        return response.body
    }

    suspend inline fun <reified T> requestJson(
        method: String,
        path: String,
        body: ByteArray? = null,
        contentType: String? = "application/json",
        extraHeaders: Map<String, String> = emptyMap(),
        skipRetry: Boolean = false,
    ): T {
        val data = request(
            method,
            path,
            body,
            contentType = contentType,
            extraHeaders = extraHeaders,
            skipRetry = skipRetry,
        )
        return try {
            clientJson.decodeFromString(String(data, StandardCharsets.UTF_8))
        } catch (e: Exception) {
            throw LoomupError(
                "failed to decode response: ${e.message}",
                code = "decode_error",
            )
        }
    }

    @PublishedApi
    internal val clientJson: Json get() = json

    private fun parseError(data: ByteArray, status: Int): LoomupError {
        val text = String(data, StandardCharsets.UTF_8)
        return try {
            val body = json.decodeFromString<ErrorBody>(text)
            val msg = body.error?.message ?: body.message ?: text.ifEmpty { "HTTP $status" }
            LoomupError(msg, code = body.error?.code, status = status)
        } catch (_: Exception) {
            LoomupError(text.ifEmpty { "HTTP $status" }, code = null, status = status)
        }
    }

    // MARK: - Auth methods

    suspend fun signUp(email: String, password: String): AuthTokens {
        val body = buildJsonObject {
            put("email", email)
            put("password", password)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        val env: DataEnvelope<AuthTokens> = requestJson(
            "POST",
            "/auth/register",
            body,
            skipRetry = true,
        )
        applyTokens(env.data)
        return env.data
    }

    suspend fun signIn(email: String, password: String): AuthTokens {
        val body = buildJsonObject {
            put("email", email)
            put("password", password)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        val env: DataEnvelope<AuthTokens> = requestJson(
            "POST",
            "/auth/login",
            body,
            skipRetry = true,
        )
        applyTokens(env.data)
        return env.data
    }

    suspend fun me(): User {
        val env: DataEnvelope<User> = requestJson("GET", "/auth/me")
        return env.data
    }

    suspend fun registerPushDevice(
        token: String,
        provider: String,
        platform: String? = null,
        deviceId: String? = null,
        appVersion: String? = null,
        locale: String? = null,
    ): PushDevice {
        val body = buildJsonObject {
            put("token", token)
            put("provider", provider)
            if (platform != null) put("platform", platform)
            if (deviceId != null) put("device_id", deviceId)
            if (appVersion != null) put("app_version", appVersion)
            if (locale != null) put("locale", locale)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        val env: DataEnvelope<PushDevice> = requestJson("POST", "/push/devices", body)
        return env.data
    }

    suspend fun listPushDevices(): List<PushDevice> {
        val env: DataEnvelope<List<PushDevice>> = requestJson("GET", "/push/devices")
        return env.data
    }

    suspend fun unregisterPushDevice(id: String? = null, token: String? = null) {
        when {
            !id.isNullOrEmpty() -> {
                request("DELETE", "/push/devices/${java.net.URLEncoder.encode(id, "UTF-8").replace("+", "%20")}")
            }
            !token.isNullOrEmpty() -> {
                val q = java.net.URLEncoder.encode(token, "UTF-8")
                request("DELETE", "/push/devices?token=$q")
            }
            else -> throw LoomupError("id or token required to unregister device", code = "bad_request")
        }
    }

    suspend fun refresh(): AuthTokens {
        val rt = refreshToken
            ?: throw LoomupError("no refresh token", code = "no_refresh")

        val existingOrNew = lock.withLock {
            refreshingDeferred?.let { return@withLock it to false }
            val deferred = CompletableDeferred<AuthTokens>()
            refreshingDeferred = deferred
            deferred to true
        }
        val deferred = existingOrNew.first
        val isOwner = existingOrNew.second
        if (!isOwner) {
            return deferred.await()
        }

        try {
            val body = buildJsonObject {
                put("refresh_token", rt)
            }.toString().toByteArray(StandardCharsets.UTF_8)
            val env: DataEnvelope<AuthTokens> = requestJson(
                "POST",
                "/auth/refresh",
                body,
                skipRetry = true,
            )
            applyTokens(env.data)
            deferred.complete(env.data)
            return env.data
        } catch (e: Exception) {
            deferred.completeExceptionally(e)
            throw e
        } finally {
            lock.withLock {
                refreshingDeferred = null
            }
        }
    }

    suspend fun signOut() {
        val rt = refreshToken
        if (rt != null) {
            try {
                val body = buildJsonObject {
                    put("refresh_token", rt)
                }.toString().toByteArray(StandardCharsets.UTF_8)
                request("POST", "/auth/logout", body, skipRetry = true)
            } catch (_: Exception) {
                // best-effort logout
            }
        }
        token = null
        refreshToken = null
        closeRealtime()
    }

    private fun applyTokens(data: AuthTokens) {
        token = data.accessToken
        refreshToken = data.refreshToken
        reauthAndResubscribe()
    }

    // MARK: - Realtime core

    fun subscribeTable(
        table: String,
        rowId: String? = null,
        handler: SubscribeHandler,
    ): Unsubscribe {
        val key = makeSubKey(table, rowId)
        val handlerId = UUID.randomUUID().toString()
        subs.getOrPut(key) { ConcurrentHashMap() }[handlerId] = handler

        ensureWs()
        sendSubscribe(table = table, rowId = rowId)

        return {
            val map = subs[key]
            map?.remove(handlerId)
            val last = map == null || map.isEmpty()
            if (last) {
                subs.remove(key)
                val msg = buildJsonObject {
                    put("type", "unsubscribe")
                    put("table", table)
                    put("channel", table)
                    if (rowId != null) put("id", rowId)
                }
                sendJson(msg)
            }
        }
    }

    suspend fun subscribeTableReady(
        table: String,
        rowId: String? = null,
        timeoutMs: Int = 5000,
        handler: SubscribeHandler,
    ): Unsubscribe {
        val unsub = subscribeTable(table = table, rowId = rowId, handler = handler)
        try {
            whenConnected(timeoutMs = timeoutMs)
            // Register the waiter *before* sending so a fast server ack cannot be dropped.
            val requestId = makeRequestId(table)
            val ackDeferred = waitForSubscribeAck(requestId, timeoutMs)
            // Yield so waitForSubscribeAck installs the pending entry before the frame goes out.
            delay(1)
            sendSubscribe(table = table, rowId = rowId, requestId = requestId)
            ackDeferred.await()
            return unsub
        } catch (e: Exception) {
            unsub()
            throw e
        }
    }

    suspend fun whenConnected(timeoutMs: Int = 5000) {
        ensureWs()
        if (isWsOpen()) return
        val start = System.currentTimeMillis()
        while (true) {
            if (isWsOpen()) return
            if (System.currentTimeMillis() - start > timeoutMs) {
                throw LoomupError("websocket connect timeout", code = "ws_timeout")
            }
            delay(25)
        }
    }

    fun closeRealtime() {
        intentionalClose = true
        reconnectJob?.cancel()
        reconnectJob = null
        val socket = ws
        ws = null
        subs.clear()
        hasOpenedOnce = false
        val pending = pendingSubscribeAcks.toMap()
        pendingSubscribeAcks.clear()

        socket?.close()
        for ((_, p) in pending) {
            p.timeoutJob.cancel()
            p.deferred.completeExceptionally(
                LoomupError(
                    "realtime closed before subscribe acknowledgement",
                    code = "realtime_closed",
                ),
            )
        }
    }

    // MARK: - Private realtime helpers

    private fun isWsOpen(): Boolean = ws?.isOpen == true

    private fun ensureWs() {
        val existing = ws
        if (existing != null && existing.isConnectingOrOpen) {
            return
        }
        intentionalClose = false
        val socket = webSocketFactory()
        ws = socket

        socket.onOpen = { handleOpen() }
        socket.onMessage = { text -> handleMessage(text) }
        socket.onClose = { handleClose() }
        socket.connect(realtimeWebSocketUrl(url))
    }

    private fun handleOpen() {
        reconnectAttempt = 0
        val access = token
        val keys = subs.keys.toList()
        val isReconnect = hasOpenedOnce
        hasOpenedOnce = true
        val shouldResync = isReconnect && keys.isNotEmpty()

        if (access != null) {
            sendJson(buildJsonObject {
                put("type", "auth")
                put("token", access)
            })
        }
        for (key in keys) {
            val (table, rowId) = parseSubKey(key)
            sendSubscribe(table = table, rowId = rowId)
        }
        if (shouldResync) {
            scope.launch {
                resyncSubscriptions()
            }
        }
    }

    private fun handleMessage(text: String) {
        val element = try {
            json.parseToJsonElement(text)
        } catch (_: Exception) {
            return
        }
        val obj = element as? JsonObject ?: return
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return

        if (type == "change") {
            val table = obj["table"]?.jsonPrimitive?.contentOrNull ?: ""
            val id = stringifyId(jsonPrimitiveAny(obj["id"]))
            val op = obj["op"]?.jsonPrimitive?.contentOrNull ?: ""
            val channel = obj["channel"]?.jsonPrimitive?.contentOrNull
            val ts = obj["ts"]?.jsonPrimitive?.longOrNull ?: unixSecondsNow()
            val rowData = obj["data"]?.let { dataEl ->
                if (dataEl is JsonObject) {
                    dataEl.mapValues { JsonValue.from(it.value) }
                } else {
                    null
                }
            }
            val event = ChangeEvent(
                type = "change",
                channel = channel,
                table = table,
                op = op,
                id = id,
                data = rowData,
                ts = ts,
            )
            val exact = subs[makeSubKey(table, id)]?.values?.toList().orEmpty()
            val all = subs[table]?.values?.toList().orEmpty()
            for (h in exact) h(event)
            for (h in all) h(event)
            return
        }

        val control = ControlEvent(
            type = type,
            requestId = obj["requestId"]?.jsonPrimitive?.contentOrNull,
            channel = obj["channel"]?.jsonPrimitive?.contentOrNull,
            table = obj["table"]?.jsonPrimitive?.contentOrNull,
            message = obj["message"]?.jsonPrimitive?.contentOrNull,
            code = obj["code"]?.jsonPrimitive?.contentOrNull,
            id = obj["id"]?.let { stringifyId(jsonPrimitiveAny(it)).ifEmpty { null } },
        )

        if (type == "subscribed" || type == "error") {
            resolveSubscribeAck(control)
        }

        for (h in controlHandlers.values) {
            h(control)
        }
    }

    private fun jsonPrimitiveAny(element: kotlinx.serialization.json.JsonElement?): Any? {
        if (element == null) return null
        val prim = element as? JsonPrimitive ?: return element.toString()
        if (prim.isString) return prim.content
        prim.longOrNull?.let { return it }
        prim.contentOrNull?.let { return it }
        return prim.content
    }

    private fun handleClose() {
        ws = null
        val shouldReconnect = !intentionalClose && subs.isNotEmpty()
        if (shouldReconnect) {
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        val baseMs = 1000.0
        val capMs = 30_000.0
        val exp = min(capMs, baseMs * 2.0.pow(reconnectAttempt.toDouble()))
        reconnectAttempt += 1
        val delayMs = maxOf(50.0, Random.nextDouble(0.0, exp)).toLong()
        reconnectJob = scope.launch {
            delay(delayMs)
            ensureWs()
        }
    }

    private fun reauthAndResubscribe() {
        val socket = ws
        if (socket == null || !socket.isOpen || subs.isEmpty()) {
            return
        }
        val access = token
        val keys = subs.keys.toList()

        if (access != null) {
            sendJson(buildJsonObject {
                put("type", "auth")
                put("token", access)
            })
        }
        for (key in keys) {
            val (table, rowId) = parseSubKey(key)
            sendSubscribe(table = table, rowId = rowId)
        }
    }

    private fun sendSubscribe(
        table: String,
        rowId: String? = null,
        requestId: String? = null,
    ): String {
        val rid = requestId ?: makeRequestId(table)
        val access = token
        val msg = buildJsonObject {
            put("type", "subscribe")
            put("table", table)
            put("channel", table)
            put("requestId", rid)
            if (rowId != null) put("id", rowId)
            if (access != null) put("token", access)
        }
        sendJson(msg)
        return rid
    }

    private fun sendJson(msg: JsonObject) {
        val text = json.encodeToString(JsonObject.serializer(), msg)
        val socket = ws
        if (socket?.isOpen == true) {
            socket.send(text)
        }
    }

    private fun waitForSubscribeAck(requestId: String, timeoutMs: Int): CompletableDeferred<Unit> {
        val deferred = CompletableDeferred<Unit>()
        val timeoutJob = scope.launch {
            delay(timeoutMs.toLong())
            val removed = pendingSubscribeAcks.remove(requestId)
            if (removed != null) {
                deferred.completeExceptionally(
                    LoomupError(
                        "subscribe acknowledgement timeout",
                        code = "subscribe_timeout",
                    ),
                )
            }
        }
        pendingSubscribeAcks[requestId] = PendingAck(deferred, timeoutJob)
        return deferred
    }

    private fun resolveSubscribeAck(data: ControlEvent) {
        val rid = data.requestId ?: return
        val pending = pendingSubscribeAcks.remove(rid) ?: return
        pending.timeoutJob.cancel()
        if (data.type == "subscribed") {
            pending.deferred.complete(Unit)
        } else if (data.type == "error") {
            val msg = data.message ?: data.code ?: "subscribe failed"
            pending.deferred.completeExceptionally(LoomupError(msg, code = data.code))
        }
    }

    private suspend fun resyncSubscriptions() {
        val keys = subs.keys.toList()
        for (key in keys) {
            val handlers = subs[key]?.values?.toList().orEmpty()
            if (handlers.isEmpty()) continue
            val (table, rowId) = parseSubKey(key)
            try {
                if (rowId != null) {
                    val path = "/api/${encodeURIComponent(table)}/${encodeURIComponent(rowId)}"
                    val env: DataEnvelope<Map<String, JsonValue>> = requestJson("GET", path)
                    val ts = unixSecondsNow()
                    val ev = ChangeEvent(
                        table = table,
                        op = "RESYNC",
                        id = rowId,
                        data = env.data,
                        ts = ts,
                    )
                    for (h in handlers) h(ev)
                } else {
                    var offset = 0
                    val pageSize = 100
                    var total = Int.MAX_VALUE
                    while (offset < total) {
                        val path =
                            "/api/${encodeURIComponent(table)}?limit=$pageSize&offset=$offset"
                        val env: ListEnvelope = requestJson("GET", path)
                        val rows = env.data
                        total = env.meta.total
                        val ts = unixSecondsNow()
                        val pk = tablePrimaryKeys[table] ?: "id"
                        for (row in rows) {
                            val raw = row[pk] ?: continue
                            val id = when (raw) {
                                is JsonValue.String -> raw.value
                                is JsonValue.Number -> {
                                    val n = raw.value
                                    if (n == n.toLong().toDouble()) n.toLong().toString()
                                    else n.toString()
                                }
                                is JsonValue.Bool -> if (raw.value) "1" else "0"
                                else -> continue
                            }
                            val ev = ChangeEvent(
                                table = table,
                                op = "RESYNC",
                                id = id,
                                data = row,
                                ts = ts,
                            )
                            for (h in handlers) h(ev)
                        }
                        if (rows.isEmpty()) break
                        offset += rows.size
                        if (rows.size < pageSize) break
                    }
                }
            } catch (_: Exception) {
                // best-effort catch-up
            }
        }
    }
}
