import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// Response from [HttpTransport.request].
class HttpTransportResponse {
  final int statusCode;
  final Uint8List body;
  final Map<String, String> headers;

  const HttpTransportResponse({
    required this.statusCode,
    required this.body,
    this.headers = const {},
  });

  String get bodyText => utf8.decode(body);
}

/// Injectable HTTP transport (defaults to `package:http`).
abstract class HttpTransport {
  Future<HttpTransportResponse> request({
    required String method,
    required Uri url,
    Map<String, String>? headers,
    List<int>? body,
  });
}

/// Production transport using [http.Client].
class PackageHttpTransport implements HttpTransport {
  final http.Client _client;
  final bool _ownsClient;

  PackageHttpTransport([http.Client? client])
      : _client = client ?? http.Client(),
        _ownsClient = client == null;

  @override
  Future<HttpTransportResponse> request({
    required String method,
    required Uri url,
    Map<String, String>? headers,
    List<int>? body,
  }) async {
    final req = http.Request(method, url);
    if (headers != null) req.headers.addAll(headers);
    if (body != null) req.bodyBytes = body;
    final streamed = await _client.send(req);
    final bytes = await streamed.stream.toBytes();
    return HttpTransportResponse(
      statusCode: streamed.statusCode,
      body: Uint8List.fromList(bytes),
      headers: streamed.headers,
    );
  }

  void close() {
    if (_ownsClient) _client.close();
  }
}
