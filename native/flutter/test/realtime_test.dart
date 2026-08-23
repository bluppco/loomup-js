import 'dart:async';
import 'dart:convert';

import 'package:loomup/loomup.dart';
import 'package:test/test.dart';

import 'mocks.dart';

Map<String, dynamic>? _tryParse(String text) {
  try {
    final decoded = jsonDecode(text);
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
  } catch (_) {}
  return null;
}

/// Factory that auto-acks subscribe frames with `subscribed`.
WebSocketFactory autoAckFactory({
  void Function(MockWebSocket ws)? onCreated,
  bool errorAck = false,
}) {
  return () {
    final ws = MockWebSocket();
    onCreated?.call(ws);
    ws.onSend = (text) {
      final obj = _tryParse(text);
      if (obj != null && obj['type'] == 'subscribe') {
        final rid = obj['requestId'];
        scheduleMicrotask(() {
          if (errorAck) {
            ws.simulateMessage(
              jsonEncode({
                'type': 'error',
                'requestId': rid,
                'code': 'SUBSCRIBE_ERROR',
                'message': 'forbidden',
              }),
            );
          } else {
            ws.simulateMessage(
              jsonEncode({
                'type': 'subscribed',
                'requestId': rid,
                'table': obj['table'],
              }),
            );
          }
        });
      }
    };
    return ws;
  };
}

void main() {
  test('injected WebSocket constructed on subscribe', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: box.factory(),
    );
    expect(box.socket, isNull);
    final unsub = c.from('todos').subscribe((_) {});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(box.socket, isNotNull);
    expect(box.socket!.connectCount, 1);
    unsub();
    c.closeRealtime();
  });

  test('control error frames surface with code', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: box.factory(),
    );
    final controls = <ControlEvent>[];
    final off = c.onControl(controls.add);
    final unsub = c.from('todos').subscribe((_) {});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    box.socket?.simulateMessage(
      '{"type":"error","code":"AUTH_ERROR","message":"invalid or expired token"}',
    );
    box.socket?.simulateMessage(
      '{"type":"error","code":"SUBSCRIBE_ERROR","table":"todos","message":"subscribe forbidden"}',
    );
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(
      controls.any((e) => e.type == 'error' && e.code == 'AUTH_ERROR'),
      isTrue,
    );
    expect(
      controls.any((e) => e.type == 'error' && e.code == 'SUBSCRIBE_ERROR'),
      isTrue,
    );
    off();
    unsub();
    c.closeRealtime();
  });

  test('setToken reauths and resubscribes', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      token: 'old-token',
      webSocketFactory: box.factory(),
    );
    final unsub = c.from('todos').subscribe((_) {}, rowId: '1');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    box.socket?.clearSent();
    c.setToken('new-token');
    await Future<void>.delayed(const Duration(milliseconds: 10));
    final frames = box.socket?.parsedSent() ?? [];
    expect(
      frames.any((f) => f['type'] == 'auth' && f['token'] == 'new-token'),
      isTrue,
      reason: '$frames',
    );
    expect(
      frames.any((f) => f['type'] == 'subscribe' && f['token'] == 'new-token'),
      isTrue,
      reason: '$frames',
    );
    unsub();
    c.closeRealtime();
  });

  test('row unsub sends id', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: box.factory(),
    );
    final u1 = c.from('todos').subscribe((_) {}, rowId: '1');
    final u2 = c.from('todos').subscribe((_) {}, rowId: '2');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    u1();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    final unsubs = (box.socket?.parsedSent() ?? [])
        .where((f) => f['type'] == 'unsubscribe')
        .toList();
    expect(unsubs.any((f) => f['id'] == '1'), isTrue, reason: '$unsubs');
    u2();
    c.closeRealtime();
  });

  test('subscribe with hash in rowId', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      token: 'tok1',
      webSocketFactory: box.factory(),
    );
    const rowId = 'prefix#with#hashes';
    final unsub = c.from('items').subscribe((_) {}, rowId: rowId);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final subs = (box.socket?.parsedSent() ?? [])
        .where((f) => f['type'] == 'subscribe')
        .toList();
    expect(
      subs.any((f) => f['id'] == rowId && f['table'] == 'items'),
      isTrue,
      reason: '$subs',
    );
    unsub();
    c.closeRealtime();
  });

  test('change events fan out to table and row handlers', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: box.factory(),
    );
    final tableEvents = <ChangeEvent>[];
    final rowEvents = <ChangeEvent>[];
    final u1 = c.from('todos').subscribe(tableEvents.add);
    final u2 = c.from('todos').subscribe(rowEvents.add, rowId: '9');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    box.socket?.simulateMessage(
      '{"type":"change","table":"todos","op":"INSERT","id":"9","data":{"id":9,"title":"x"},"ts":100}',
    );
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(tableEvents.length, 1);
    expect(rowEvents.length, 1);
    expect(tableEvents.first.op, 'INSERT');
    expect(rowEvents.first.id, '9');
    u1();
    u2();
    c.closeRealtime();
  });

  test('subscribeReady resolves on subscribed ack', () async {
    MockWebSocket? last;
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: autoAckFactory(onCreated: (ws) => last = ws),
    );

    final unsub = await c.from('todos').subscribeReady((_) {});
    expect(unsub, isNotNull);
    expect(last, isNotNull);
    unsub();
    c.closeRealtime();
  });

  test('subscribeReady rejects on error frame', () async {
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: autoAckFactory(errorAck: true),
    );

    try {
      await c.from('todos').subscribeReady((_) {});
      fail('expected throw');
    } on LoomupException catch (e) {
      expect(e.message, 'forbidden');
      expect(e.code, 'SUBSCRIBE_ERROR');
    }
    c.closeRealtime();
  });

  test('refresh applyTokens sends auth and resubscribe', () async {
    final http = MockHttp();
    http.handler = (method, url, auth, body) async {
      if (url.endsWith('/auth/refresh')) {
        return (
          body: jsonBytes({
            'data': {
              'access_token': 'rotated-access',
              'refresh_token': 'rotated-refresh',
              'token_type': 'Bearer',
              'expires_in': 900,
            },
          }),
          status: 200,
        );
      }
      return (body: 'nope'.codeUnits, status: 500);
    };
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://example.test',
      token: 'old-access',
      refreshToken: 'r1',
      http: http,
      webSocketFactory: box.factory(),
    );
    final unsub = c.from('todos').subscribe((_) {}, rowId: '42');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    if (box.socket?.isOpen != true) {
      box.socket?.simulateOpen();
    }
    box.socket?.clearSent();
    await c.refresh();
    expect(c.accessToken, 'rotated-access');
    await Future<void>.delayed(const Duration(milliseconds: 10));
    final frames = box.socket?.parsedSent() ?? [];
    expect(
      frames.any(
        (f) => f['type'] == 'auth' && f['token'] == 'rotated-access',
      ),
      isTrue,
      reason: '$frames',
    );
    expect(
      frames.any(
        (f) =>
            f['type'] == 'subscribe' &&
            f['token'] == 'rotated-access' &&
            f['id'] == '42',
      ),
      isTrue,
      reason: '$frames',
    );
    unsub();
    c.closeRealtime();
  });

  test('unexpected close schedules reconnect', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: box.factory(),
    );
    final unsub = c.from('todos').subscribe((_) {});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(box.totalConnectCount, 1);
    box.socket!.simulateClose();
    // First reconnect: full jitter in [50ms, 1000ms] — wait past the cap.
    await Future<void>.delayed(const Duration(milliseconds: 1200));
    expect(box.totalConnectCount, greaterThanOrEqualTo(2));
    unsub();
    c.closeRealtime();
  });

  test('closeRealtime stops reconnect and fails pending acks', () async {
    final box = MockWebSocketBox()..autoOpen = false;
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: box.factory(),
    );
    final ready = c.from('todos').subscribeReady((_) {}, timeoutMs: 2000);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    c.closeRealtime();
    try {
      await ready;
      fail('expected throw');
    } on LoomupException catch (e) {
      expect(e.code, 'realtime_closed');
    }
  });

  test('RESYNC after reconnect for row subscription', () async {
    final http = MockHttp();
    http.handler = (method, url, auth, body) async {
      if (url.contains('/api/todos/7')) {
        return (
          body: jsonBytes({
            'data': {'id': 7, 'title': 'catch-up'},
          }),
          status: 200,
        );
      }
      return (body: 'nope'.codeUnits, status: 404);
    };
    final box = MockWebSocketBox();
    final events = <ChangeEvent>[];
    final c = createClient(
      url: 'http://localhost:3000',
      http: http,
      webSocketFactory: box.factory(),
    );
    final unsub = c.from('todos').subscribe(events.add, rowId: '7');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    // Simulate disconnect + reconnect (second open triggers RESYNC).
    // First reconnect delay is full-jitter up to 1s.
    box.socket!.simulateClose();
    await Future<void>.delayed(const Duration(milliseconds: 1300));
    expect(events.any((e) => e.op == 'RESYNC' && e.id == '7'), isTrue);
    unsub();
    c.closeRealtime();
  });

  test('changes stream delivers and unsubscribes on cancel', () async {
    final box = MockWebSocketBox();
    final c = createClient(
      url: 'http://localhost:3000',
      webSocketFactory: box.factory(),
    );
    final events = <ChangeEvent>[];
    final sub = c.from('todos').changes().listen(events.add);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    box.socket?.simulateMessage(
      '{"type":"change","table":"todos","op":"UPDATE","id":"1","data":{"id":1},"ts":1}',
    );
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(events.length, 1);
    await sub.cancel();
    final unsubs = (box.socket?.parsedSent() ?? [])
        .where((f) => f['type'] == 'unsubscribe')
        .toList();
    expect(unsubs, isNotEmpty);
    c.closeRealtime();
  });
}
