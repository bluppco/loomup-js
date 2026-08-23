/// Convert an HTTP(S) API base URL to the realtime WebSocket URL (`/realtime`).
Uri realtimeWebSocketUrl(Uri httpBase) {
  final scheme = httpBase.scheme.toLowerCase() == 'https' ? 'wss' : 'ws';
  return Uri(
    scheme: scheme,
    host: httpBase.host,
    port: httpBase.hasPort ? httpBase.port : null,
    path: '/realtime',
  );
}

/// Join base URL with a path (path may start with `/api/...`).
Uri joinUrl(Uri base, String path) {
  final baseStr = base.toString().replaceAll(RegExp(r'/+$'), '');
  final p = path.startsWith('/') ? path : '/$path';
  return Uri.parse('$baseStr$p');
}

/// Percent-encode a path segment (table name / id).
String encodeUriComponent(String value) {
  return Uri.encodeComponent(value);
}

int unixSecondsNow() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

String makeRequestId(String table) {
  final rand = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
  final ms = DateTime.now().millisecondsSinceEpoch;
  return 'sub_${table}_${ms}_$rand';
}
