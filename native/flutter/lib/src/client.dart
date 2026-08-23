import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'errors.dart';
import 'http_transport.dart';
import 'models.dart';
import 'realtime_url.dart';
import 'storage.dart';
import 'sub_key.dart';
import 'table_query.dart';
import 'websocket.dart';

/// Options for constructing a client.
class LoomupClientOptions {
  final String url;
  final String? token;
  final String? refreshToken;
  final String? publishableKey;
  final String? serviceKey;
  final HttpTransport? http;
  final WebSocketFactory? webSocketFactory;
  final void Function(AuthTokens? tokens)? onTokens;

  const LoomupClientOptions({
    required this.url,
    this.token,
    this.refreshToken,
    this.publishableKey,
    this.serviceKey,
    this.http,
    this.webSocketFactory,
    this.onTokens,
  });
}

/// Create a Loomup client (TypeScript / Swift `createClient` equivalent).
LoomupClient createClient({
  required String url,
  String? token,
  String? refreshToken,
  String? publishableKey,
  String? serviceKey,
  HttpTransport? http,
  WebSocketFactory? webSocketFactory,
  void Function(AuthTokens? tokens)? onTokens,
}) {
  return LoomupClient(
    LoomupClientOptions(
      url: url,
      token: token,
      refreshToken: refreshToken,
      publishableKey: publishableKey,
      serviceKey: serviceKey,
      http: http,
      webSocketFactory: webSocketFactory,
      onTokens: onTokens,
    ),
  );
}

/// Loomup Realtime client: REST + WebSocket subscriptions.
class LoomupClient {
  late final Uri url;
  final HttpTransport _http;
  final WebSocketFactory _webSocketFactory;
  final void Function(AuthTokens? tokens)? _onTokens;
  final String? _publishableKey;
  final String? _serviceKey;

  String? _token;
  String? _refreshToken;

  WebSocketConnecting? _ws;
  final Map<String, Map<Object, SubscribeHandler>> _subs = {};
  final Map<Object, ControlHandler> _controlHandlers = {};
  final Map<String, _PendingAck> _pendingSubscribeAcks = {};
  Timer? _reconnectTimer;
  bool _intentionalClose = false;
  bool _hasOpenedOnce = false;
  int _reconnectAttempt = 0;
  final Map<String, String> _tablePrimaryKeys = {};
  Future<AuthTokens>? _refreshing;
  final _rng = Random();

  LoomupClient(LoomupClientOptions options)
      : _http = options.http ?? PackageHttpTransport(),
        _webSocketFactory =
            options.webSocketFactory ?? (() => WebSocketChannelConnection()),
        _onTokens = options.onTokens,
        _publishableKey = options.publishableKey,
        _serviceKey = options.serviceKey {
    var base = options.url;
    while (base.endsWith('/')) {
      base = base.substring(0, base.length - 1);
    }
    url = Uri.parse(base);
    _token = options.token;
    _refreshToken = options.refreshToken;
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  String? get accessToken => _token;

  String? get refreshTokenValue => _refreshToken;

  bool get reconnectEnabled => !_intentionalClose;

  void setToken(String? token) {
    _token = token;
    _reauthAndResubscribe();
  }

  void setRefreshToken(String? token) {
    _refreshToken = token;
  }

  /// Set access + refresh tokens together and re-auth open realtime sockets.
  /// Invokes [onTokens] when configured.
  void setSession(SessionTokens session) {
    _applyTokens(AuthTokens(
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenType: session.tokenType ?? 'Bearer',
      expiresIn: session.expiresIn ?? 0,
      user: session.user,
    ));
  }

  void setTablePrimaryKey(String table, String pk) {
    _tablePrimaryKeys[table] = pk;
  }

  // ---------------------------------------------------------------------------
  // Auth surface
  // ---------------------------------------------------------------------------

  AuthAPI get auth => AuthAPI(this);

  /// Object storage (`/storage/v1`). Requires server `[storage].enabled = true`.
  StorageAPI get storage => StorageAPI(this);

  TableQuery from(String table) => TableQuery(this, table);

  Unsubscribe onControl(ControlHandler handler) {
    final id = Object();
    _controlHandlers[id] = handler;
    return () {
      _controlHandlers.remove(id);
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  Future<Map<String, dynamic>> requestJson(
    String method,
    String path, {
    Object? body,
    Map<String, String>? headers,
    bool skipRetry = false,
  }) async {
    final data = await request(
      method,
      path,
      body: body,
      headers: headers,
      skipRetry: skipRetry,
    );
    if (data.isEmpty) return {};
    final decoded = jsonDecode(utf8.decode(data));
    if (decoded is Map<String, dynamic>) return decoded;
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
    throw const LoomupException(
      'failed to decode response',
      code: 'decode_error',
    );
  }

  Future<List<int>> request(
    String method,
    String path, {
    Object? body,
    Map<String, String>? headers,
    bool skipRetry = false,
  }) async {
    final requestHeaders = <String, String>{
      'Accept': 'application/json',
      ...?headers,
    };
    final access = _token;
    if (access != null) {
      requestHeaders['Authorization'] = 'Bearer $access';
    } else if (_serviceKey != null) {
      requestHeaders['Authorization'] = 'Bearer $_serviceKey';
    }
    if (_publishableKey != null) {
      requestHeaders['X-Loomup-Key'] = _publishableKey!;
    }
    List<int>? payload;
    if (body != null) {
      requestHeaders['Content-Type'] = 'application/json';
      payload = utf8.encode(jsonEncode(body));
    }

    final fullUrl = joinUrl(url, path);
    final res = await _http.request(
      method: method,
      url: fullUrl,
      headers: requestHeaders,
      body: payload,
    );

    if (res.statusCode == 401 &&
        !skipRetry &&
        _refreshToken != null &&
        path != '/auth/refresh' &&
        path != '/auth/login' &&
        path != '/auth/register') {
      try {
        await refresh();
        return request(
          method,
          path,
          body: body,
          headers: headers,
          skipRetry: true,
        );
      } catch (_) {
        // fall through with original error
      }
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _parseError(res.bodyText, res.statusCode);
    }
    return res.body;
  }

  /// Storage HTTP: raw body + custom headers (not forced JSON Content-Type).
  Future<List<int>> requestStorageBytes(
    String method,
    String path, {
    List<int>? body,
    Map<String, String>? headers,
    bool skipRetry = false,
  }) async {
    final h = <String, String>{
      'Accept': '*/*',
      ...?headers,
    };
    final access = _token;
    if (access != null) {
      h['Authorization'] = 'Bearer $access';
    } else if (_serviceKey != null) {
      h['Authorization'] = 'Bearer $_serviceKey';
    }
    if (_publishableKey != null) {
      h['X-Loomup-Key'] = _publishableKey!;
    }
    final res = await _http.request(
      method: method,
      url: joinUrl(url, path),
      headers: h,
      body: body,
    );
    if (res.statusCode == 401 &&
        !skipRetry &&
        _refreshToken != null &&
        !path.startsWith('/auth/')) {
      try {
        await refresh();
        return requestStorageBytes(
          method,
          path,
          body: body,
          headers: headers,
          skipRetry: true,
        );
      } catch (_) {}
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _parseError(res.bodyText, res.statusCode);
    }
    return res.body;
  }

  Future<Map<String, dynamic>> requestStorageJson(
    String method,
    String path, {
    List<int>? body,
    Map<String, String>? headers,
    bool skipRetry = false,
  }) async {
    final h = <String, String>{
      'Accept': 'application/json',
      ...?headers,
    };
    final bytes = await requestStorageBytes(
      method,
      path,
      body: body,
      headers: h,
      skipRetry: skipRetry,
    );
    if (bytes.isEmpty) return {};
    final decoded = jsonDecode(utf8.decode(bytes));
    if (decoded is Map<String, dynamic>) return decoded;
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
    throw const LoomupException(
      'failed to decode storage response',
      code: 'decode_error',
    );
  }

  LoomupException _parseError(String text, int status) {
    try {
      final json = jsonDecode(text);
      if (json is Map) {
        final err = json['error'];
        if (err is Map) {
          final msg = err['message']?.toString() ??
              json['message']?.toString() ??
              text;
          return LoomupException(
            msg,
            code: err['code']?.toString(),
            status: status,
          );
        }
        if (json['message'] != null) {
          return LoomupException(
            json['message'].toString(),
            status: status,
          );
        }
      }
    } catch (_) {
      // ignore decode errors
    }
    return LoomupException(
      text.isNotEmpty ? text : 'HTTP $status',
      status: status,
    );
  }

  // ---------------------------------------------------------------------------
  // Auth methods
  // ---------------------------------------------------------------------------

  Future<AuthTokens> signUp({
    required String email,
    required String password,
  }) async {
    final json = await requestJson(
      'POST',
      '/auth/register',
      body: {'email': email, 'password': password},
      skipRetry: true,
    );
    final tokens = AuthTokens.fromJson(
      Map<String, dynamic>.from(json['data'] as Map),
    );
    _applyTokens(tokens);
    return tokens;
  }

  Future<AuthTokens> signIn({
    required String email,
    required String password,
  }) async {
    final json = await requestJson(
      'POST',
      '/auth/login',
      body: {'email': email, 'password': password},
      skipRetry: true,
    );
    final tokens = AuthTokens.fromJson(
      Map<String, dynamic>.from(json['data'] as Map),
    );
    _applyTokens(tokens);
    return tokens;
  }

  Future<User> me() async {
    final json = await requestJson('GET', '/auth/me');
    return User.fromJson(Map<String, dynamic>.from(json['data'] as Map));
  }

  Future<AuthTokens> refresh() async {
    final rt = _refreshToken;
    if (rt == null) {
      throw const LoomupException('no refresh token', code: 'no_refresh');
    }
    if (_refreshing != null) {
      return _refreshing!;
    }
    _refreshing = () async {
      final json = await requestJson(
        'POST',
        '/auth/refresh',
        body: {'refresh_token': rt},
        skipRetry: true,
      );
      final tokens = AuthTokens.fromJson(
        Map<String, dynamic>.from(json['data'] as Map),
      );
      _applyTokens(tokens);
      return tokens;
    }();
    try {
      return await _refreshing!;
    } finally {
      _refreshing = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Push devices
  // ---------------------------------------------------------------------------

  Future<PushDevice> registerPushDevice({
    required String token,
    required String provider,
    String? platform,
    String? deviceId,
    String? appVersion,
    String? locale,
  }) async {
    final json = await requestJson(
      'POST',
      '/push/devices',
      body: {
        'token': token,
        'provider': provider,
        if (platform != null) 'platform': platform,
        if (deviceId != null) 'device_id': deviceId,
        if (appVersion != null) 'app_version': appVersion,
        if (locale != null) 'locale': locale,
      },
    );
    return PushDevice.fromJson(Map<String, dynamic>.from(json['data'] as Map));
  }

  Future<List<PushDevice>> listPushDevices() async {
    final json = await requestJson('GET', '/push/devices');
    final data = json['data'];
    if (data is! List) return [];
    return data
        .whereType<Map>()
        .map((e) => PushDevice.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<void> unregisterPushDevice({String? id, String? token}) async {
    if (id != null && id.isNotEmpty) {
      await request('DELETE', '/push/devices/${Uri.encodeComponent(id)}');
      return;
    }
    if (token != null && token.isNotEmpty) {
      await request(
        'DELETE',
        '/push/devices?token=${Uri.encodeQueryComponent(token)}',
      );
      return;
    }
    throw const LoomupException(
      'id or token required to unregister device',
      code: 'bad_request',
    );
  }

  Future<void> signOut() async {
    final rt = _refreshToken;
    if (rt != null) {
      try {
        await request(
          'POST',
          '/auth/logout',
          body: {'refresh_token': rt},
          skipRetry: true,
        );
      } catch (_) {
        // ignore
      }
    }
    _token = null;
    _refreshToken = null;
    closeRealtime();
    try {
      _onTokens?.call(null);
    } catch (_) {
      // ignore storage errors
    }
  }

  void _applyTokens(AuthTokens data) {
    _token = data.accessToken;
    _refreshToken = data.refreshToken;
    _reauthAndResubscribe();
    try {
      _onTokens?.call(data);
    } catch (_) {
      // ignore storage errors
    }
  }

  // ---------------------------------------------------------------------------
  // Realtime
  // ---------------------------------------------------------------------------

  Unsubscribe subscribeTable(
    String table,
    SubscribeHandler handler, {
    String? rowId,
  }) {
    final key = makeSubKey(table, rowId);
    final handlerId = Object();
    _subs.putIfAbsent(key, () => {});
    _subs[key]![handlerId] = handler;

    _ensureWs();
    _sendSubscribe(table, rowId: rowId);

    return () {
      final map = _subs[key];
      if (map == null) return;
      map.remove(handlerId);
      final last = map.isEmpty;
      if (last) {
        _subs.remove(key);
        final msg = <String, dynamic>{
          'type': 'unsubscribe',
          'table': table,
          'channel': table,
        };
        if (rowId != null) msg['id'] = rowId;
        _sendJson(msg);
      }
    };
  }

  Future<Unsubscribe> subscribeTableReady(
    String table,
    SubscribeHandler handler, {
    String? rowId,
    int timeoutMs = 5000,
  }) async {
    final unsub = subscribeTable(table, handler, rowId: rowId);
    try {
      await whenConnected(timeoutMs: timeoutMs);
      // Register waiter before sending so a fast server ack cannot be dropped.
      final requestId = makeRequestId(table);
      final ackFuture = _waitForSubscribeAck(requestId, timeoutMs);
      // Microtask yield so the pending map is installed before the frame leaves.
      await Future<void>.delayed(Duration.zero);
      _sendSubscribe(table, rowId: rowId, requestId: requestId);
      await ackFuture;
      return unsub;
    } catch (e) {
      unsub();
      rethrow;
    }
  }

  Future<void> whenConnected({int timeoutMs = 5000}) async {
    _ensureWs();
    if (_isWsOpen()) return;
    final start = DateTime.now();
    while (true) {
      if (_isWsOpen()) return;
      if (_intentionalClose) {
        throw const LoomupException(
          'realtime closed before subscribe acknowledgement',
          code: 'realtime_closed',
        );
      }
      if (DateTime.now().difference(start).inMilliseconds > timeoutMs) {
        throw const LoomupException(
          'websocket connect timeout',
          code: 'ws_timeout',
        );
      }
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
  }

  void closeRealtime() {
    _intentionalClose = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final socket = _ws;
    _ws = null;
    _subs.clear();
    _hasOpenedOnce = false;
    final pending = Map<String, _PendingAck>.from(_pendingSubscribeAcks);
    _pendingSubscribeAcks.clear();

    socket?.close();
    for (final p in pending.values) {
      p.timer.cancel();
      if (!p.completer.isCompleted) {
        p.completer.completeError(
          const LoomupException(
            'realtime closed before subscribe acknowledgement',
            code: 'realtime_closed',
          ),
        );
      }
    }
  }

  bool _isWsOpen() => _ws?.isOpen == true;

  void _ensureWs() {
    final existing = _ws;
    if (existing != null && existing.isConnectingOrOpen) {
      return;
    }
    _intentionalClose = false;
    final socket = _webSocketFactory();
    _ws = socket;

    socket.onOpen = _handleOpen;
    socket.onMessage = _handleMessage;
    socket.onClose = _handleClose;
    socket.connect(realtimeWebSocketUrl(url));
  }

  void _handleOpen() {
    _reconnectAttempt = 0;
    final access = _token;
    final keys = List<String>.from(_subs.keys);
    final isReconnect = _hasOpenedOnce;
    _hasOpenedOnce = true;
    final shouldResync = isReconnect && keys.isNotEmpty;

    if (access != null) {
      _sendJson({'type': 'auth', 'token': access});
    }
    for (final key in keys) {
      final parsed = parseSubKey(key);
      _sendSubscribe(parsed.table, rowId: parsed.rowId);
    }
    if (shouldResync) {
      unawaited(_resyncSubscriptions());
    }
  }

  void _handleMessage(String text) {
    Map<String, dynamic> obj;
    try {
      final decoded = jsonDecode(text);
      if (decoded is! Map) return;
      obj = Map<String, dynamic>.from(decoded);
    } catch (_) {
      return;
    }

    final type = obj['type'] as String?;
    if (type == null) return;

    if (type == 'change') {
      final event = ChangeEvent.fromJson(obj);
      final exact = _subs[makeSubKey(event.table, event.id)];
      final all = _subs[event.table];
      if (exact != null) {
        for (final h in exact.values) {
          h(event);
        }
      }
      if (all != null) {
        for (final h in all.values) {
          h(event);
        }
      }
      return;
    }

    final control = ControlEvent.fromJson(obj);
    if (type == 'subscribed' || type == 'error') {
      _resolveSubscribeAck(control);
    }
    for (final h in List<ControlHandler>.from(_controlHandlers.values)) {
      h(control);
    }
  }

  void _handleClose() {
    _ws = null;
    final shouldReconnect = !_intentionalClose && _subs.isNotEmpty;
    if (shouldReconnect) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    const baseMs = 1000.0;
    const capMs = 30000.0;
    final exp = min(capMs, baseMs * pow(2.0, _reconnectAttempt));
    _reconnectAttempt += 1;
    // Full jitter: uniform in [0, exp], floor at 50ms
    final delay = max(50.0, _rng.nextDouble() * exp);
    _reconnectTimer = Timer(Duration(milliseconds: delay.round()), _ensureWs);
  }

  void _reauthAndResubscribe() {
    final ws = _ws;
    if (ws == null || !ws.isOpen || _subs.isEmpty) return;
    final access = _token;
    final keys = List<String>.from(_subs.keys);
    if (access != null) {
      _sendJson({'type': 'auth', 'token': access});
    }
    for (final key in keys) {
      final parsed = parseSubKey(key);
      _sendSubscribe(parsed.table, rowId: parsed.rowId);
    }
  }

  String _sendSubscribe(
    String table, {
    String? rowId,
    String? requestId,
  }) {
    final rid = requestId ?? makeRequestId(table);
    final msg = <String, dynamic>{
      'type': 'subscribe',
      'table': table,
      'channel': table,
      'requestId': rid,
    };
    if (rowId != null) msg['id'] = rowId;
    if (_token != null) msg['token'] = _token;
    _sendJson(msg);
    return rid;
  }

  void _sendJson(Map<String, dynamic> msg) {
    final socket = _ws;
    if (socket != null && socket.isOpen) {
      socket.send(jsonEncode(msg));
    }
  }

  Future<void> _waitForSubscribeAck(String requestId, int timeoutMs) {
    final completer = Completer<void>();
    final timer = Timer(Duration(milliseconds: timeoutMs), () {
      final pending = _pendingSubscribeAcks.remove(requestId);
      if (pending != null && !pending.completer.isCompleted) {
        pending.completer.completeError(
          const LoomupException(
            'subscribe acknowledgement timeout',
            code: 'subscribe_timeout',
          ),
        );
      }
    });
    _pendingSubscribeAcks[requestId] = _PendingAck(
      completer: completer,
      timer: timer,
    );
    return completer.future;
  }

  void _resolveSubscribeAck(ControlEvent data) {
    final rid = data.requestId;
    if (rid == null) return;
    final pending = _pendingSubscribeAcks.remove(rid);
    if (pending == null) return;
    pending.timer.cancel();
    if (pending.completer.isCompleted) return;
    if (data.type == 'subscribed') {
      pending.completer.complete();
    } else if (data.type == 'error') {
      pending.completer.completeError(
        LoomupException(
          data.message ?? data.code ?? 'subscribe failed',
          code: data.code,
        ),
      );
    }
  }

  Future<void> _resyncSubscriptions() async {
    final keys = List<String>.from(_subs.keys);
    for (final key in keys) {
      final handlers = List<SubscribeHandler>.from(
        (_subs[key] ?? {}).values,
      );
      if (handlers.isEmpty) continue;
      final parsed = parseSubKey(key);
      try {
        if (parsed.rowId != null) {
          final rowId = parsed.rowId!;
          final path =
              '/api/${encodeUriComponent(parsed.table)}/${encodeUriComponent(rowId)}';
          final json = await requestJson('GET', path);
          final data = Map<String, dynamic>.from(json['data'] as Map);
          final ts = unixSecondsNow();
          final ev = ChangeEvent(
            table: parsed.table,
            op: 'RESYNC',
            id: rowId,
            data: data,
            ts: ts,
          );
          for (final h in handlers) {
            h(ev);
          }
        } else {
          var offset = 0;
          const pageSize = 100;
          var total = 1 << 30;
          while (offset < total) {
            final path =
                '/api/${encodeUriComponent(parsed.table)}?limit=$pageSize&offset=$offset';
            final json = await requestJson('GET', path);
            final rowsRaw = json['data'];
            final rows = rowsRaw is List
                ? rowsRaw
                    .whereType<Map>()
                    .map((e) => Map<String, dynamic>.from(e))
                    .toList()
                : <Map<String, dynamic>>[];
            final meta = json['meta'];
            if (meta is Map) {
              total = _asIntLocal(meta['total']);
            } else {
              total = rows.length;
            }
            final ts = unixSecondsNow();
            final pk = _tablePrimaryKeys[parsed.table] ?? 'id';
            for (final row in rows) {
              if (!row.containsKey(pk)) continue;
              final raw = row[pk];
              if (raw == null) continue;
              final id = stringifyId(raw);
              final ev = ChangeEvent(
                table: parsed.table,
                op: 'RESYNC',
                id: id,
                data: row,
                ts: ts,
              );
              for (final h in handlers) {
                h(ev);
              }
            }
            if (rows.isEmpty) break;
            offset += rows.length;
            if (rows.length < pageSize) break;
          }
        }
      } catch (_) {
        // best-effort catch-up
      }
    }
  }
}

class _PendingAck {
  final Completer<void> completer;
  final Timer timer;

  _PendingAck({required this.completer, required this.timer});
}

int _asIntLocal(Object? value) {
  if (value == null) return 0;
  if (value is int) return value;
  if (value is double) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}

/// Auth methods namespace (`client.auth.*`).
class AuthAPI {
  final LoomupClient _client;

  AuthAPI(this._client);

  Future<AuthTokens> signUp({
    required String email,
    required String password,
  }) =>
      _client.signUp(email: email, password: password);

  Future<AuthTokens> register({
    required String email,
    required String password,
  }) =>
      signUp(email: email, password: password);

  Future<AuthTokens> signIn({
    required String email,
    required String password,
  }) =>
      _client.signIn(email: email, password: password);

  Future<AuthTokens> login({
    required String email,
    required String password,
  }) =>
      signIn(email: email, password: password);

  Future<void> signOut() => _client.signOut();

  Future<void> logout() => signOut();

  Future<User> me() => _client.me();

  Future<AuthTokens> refresh() => _client.refresh();
}
