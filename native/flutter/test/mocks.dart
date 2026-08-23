import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:loomup/loomup.dart';

/// Mock HTTP transport for unit tests.
class MockHttp implements HttpTransport {
  final List<HttpCall> calls = [];
  Future<({List<int> body, int status})> Function(
    String method,
    String url,
    String? auth,
    List<int>? body,
  )? handler;

  @override
  Future<HttpTransportResponse> request({
    required String method,
    required Uri url,
    Map<String, String>? headers,
    List<int>? body,
  }) async {
    final auth = headers?['Authorization'];
    calls.add(HttpCall(
      method: method,
      url: url.toString(),
      auth: auth,
      body: body,
    ));
    final h = handler;
    if (h == null) {
      throw const LoomupException('no mock handler', code: 'test');
    }
    final result = await h(method, url.toString(), auth, body);
    return HttpTransportResponse(
      statusCode: result.status,
      body: Uint8List.fromList(result.body),
    );
  }
}

class HttpCall {
  final String method;
  final String url;
  final String? auth;
  final List<int>? body;

  HttpCall({
    required this.method,
    required this.url,
    this.auth,
    this.body,
  });
}

List<int> jsonBytes(Object object) => utf8.encode(jsonEncode(object));

/// Mock WebSocket for unit tests.
class MockWebSocket implements WebSocketConnecting {
  @override
  void Function()? onOpen;
  @override
  void Function(String text)? onMessage;
  @override
  void Function()? onClose;

  final List<String> sent = [];
  int connectCount = 0;
  bool _isOpen = false;
  bool _connecting = false;
  Duration openDelay = Duration.zero;
  bool autoOpen = true;
  void Function(String text)? onSend;

  /// Optional external hook when [connect] is called (used by [MockWebSocketBox]).
  void Function()? onConnectHook;

  @override
  bool get isOpen => _isOpen;

  @override
  bool get isConnectingOrOpen => _connecting || _isOpen;

  @override
  void connect(Uri url) {
    connectCount += 1;
    onConnectHook?.call();
    _connecting = true;
    _isOpen = false;
    if (!autoOpen) return;
    if (openDelay == Duration.zero) {
      // Schedule open on next microtask so client can finish wiring handlers.
      scheduleMicrotask(simulateOpen);
    } else {
      Timer(openDelay, simulateOpen);
    }
  }

  @override
  void send(String text) {
    sent.add(text);
    onSend?.call(text);
  }

  @override
  void close() {
    _isOpen = false;
    _connecting = false;
    onClose?.call();
  }

  void simulateOpen() {
    _isOpen = true;
    _connecting = false;
    onOpen?.call();
  }

  void simulateMessage(String text) {
    onMessage?.call(text);
  }

  void simulateClose() {
    _isOpen = false;
    _connecting = false;
    onClose?.call();
  }

  void clearSent() => sent.clear();

  List<Map<String, dynamic>> parsedSent() {
    return sent
        .map((text) {
          try {
            final decoded = jsonDecode(text);
            if (decoded is Map) return Map<String, dynamic>.from(decoded);
          } catch (_) {}
          return null;
        })
        .whereType<Map<String, dynamic>>()
        .toList();
  }
}

/// Holds the latest mock socket so tests can drive messages after connect.
class MockWebSocketBox {
  MockWebSocket? current;
  bool autoOpen = true;
  Duration openDelay = Duration.zero;

  /// Total connect() calls across all sockets produced by [factory].
  int totalConnectCount = 0;

  WebSocketFactory factory() {
    return () {
      final ws = MockWebSocket()
        ..autoOpen = autoOpen
        ..openDelay = openDelay
        ..onConnectHook = () {
          totalConnectCount += 1;
        };
      current = ws;
      return ws;
    };
  }

  MockWebSocket? get socket => current;
}
