import 'dart:async';

import 'package:web_socket_channel/web_socket_channel.dart';

/// Injectable WebSocket used by realtime.
///
/// Defaults to [WebSocketChannelConnection] (`package:web_socket_channel`).
abstract class WebSocketConnecting {
  void Function()? onOpen;
  void Function(String text)? onMessage;
  void Function()? onClose;

  /// True when the socket can send (OPEN).
  bool get isOpen;

  /// True while connecting or open.
  bool get isConnectingOrOpen;

  void connect(Uri url);
  void send(String text);
  void close();
}

typedef WebSocketFactory = WebSocketConnecting Function();

/// Production WebSocket backed by [WebSocketChannel].
class WebSocketChannelConnection implements WebSocketConnecting {
  @override
  void Function()? onOpen;
  @override
  void Function(String text)? onMessage;
  @override
  void Function()? onClose;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  bool _opened = false;
  bool _closed = false;
  bool _connecting = false;

  @override
  bool get isOpen => _opened && !_closed;

  @override
  bool get isConnectingOrOpen => (_connecting || _opened) && !_closed;

  @override
  void connect(Uri url) {
    _closed = false;
    _opened = false;
    _connecting = true;
    try {
      final channel = WebSocketChannel.connect(url);
      _channel = channel;
      // web_socket_channel does not expose a discrete "open" event on all
      // platforms; ready resolves when the handshake completes.
      channel.ready.then((_) {
        if (_closed) return;
        _opened = true;
        _connecting = false;
        onOpen?.call();
      }).catchError((_) {
        _connecting = false;
        _opened = false;
        if (!_closed) {
          _closed = true;
          onClose?.call();
        }
      });
      _sub = channel.stream.listen(
        (dynamic data) {
          if (data is String) {
            onMessage?.call(data);
          } else if (data is List<int>) {
            onMessage?.call(String.fromCharCodes(data));
          }
        },
        onDone: () {
          _opened = false;
          _connecting = false;
          if (!_closed) {
            _closed = true;
            onClose?.call();
          }
        },
        onError: (_) {
          _opened = false;
          _connecting = false;
          if (!_closed) {
            _closed = true;
            onClose?.call();
          }
        },
        cancelOnError: true,
      );
    } catch (_) {
      _connecting = false;
      _opened = false;
      _closed = true;
      onClose?.call();
    }
  }

  @override
  void send(String text) {
    if (!isOpen) return;
    _channel?.sink.add(text);
  }

  @override
  void close() {
    _closed = true;
    _opened = false;
    _connecting = false;
    _sub?.cancel();
    _sub = null;
    _channel?.sink.close();
    _channel = null;
  }
}
