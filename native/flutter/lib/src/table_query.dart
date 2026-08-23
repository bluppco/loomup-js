import 'dart:async';
import 'dart:convert';

import 'client.dart';
import 'models.dart';
import 'realtime_url.dart';

/// Fluent table accessor: CRUD + realtime for one table name.
class TableQuery {
  final LoomupClient _client;
  final String table;

  TableQuery(this._client, this.table);

  /// List rows with optional filters.
  ///
  /// Boolean `where` values are encoded as SQLite `0`/`1`.
  Future<ListResult> select({
    Map<String, Object?>? where,
    Map<String, Map<String, Object?>>? filter,
    List<String>? select,
    String? sort,
    int? limit,
    int? offset,
    String? cursor,
  }) async {
    final params = <String, String>{};
    if (cursor != null) params['cursor'] = cursor;
    if (limit != null) params['limit'] = limit.toString();
    if (offset != null) params['offset'] = offset.toString();
    if (sort != null) params['sort'] = sort;
    if (select != null && select.isNotEmpty) {
      params['select'] = select.join(',');
    }
    if (where != null) {
      for (final entry in where.entries) {
        final v = entry.value;
        if (v is bool) {
          params['where[${entry.key}]'] = v ? '1' : '0';
        } else if (v != null) {
          params['where[${entry.key}]'] = v.toString();
        }
      }
    }
    if (filter != null) {
      for (final field in filter.entries) {
        for (final operation in field.value.entries) {
          final wireOperation = switch (operation.key) {
            'isNull' => 'is_null',
            'startsWith' => 'starts_with',
            _ => operation.key,
          };
          final value = operation.value;
          if (value == null) continue;
          params['filter[${field.key}][$wireOperation]'] = value is Iterable
              ? value.join(',')
              : value.toString();
        }
      }
    }

    var path = '/api/${encodeUriComponent(table)}';
    if (params.isNotEmpty) {
      final q = params.entries
          .map((e) =>
              '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}')
          .join('&');
      path = '$path?$q';
    }

    final json = await _client.requestJson('GET', path);
    final dataRaw = json['data'];
    final data = dataRaw is List
        ? dataRaw
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];
    final metaRaw = json['meta'];
    final meta = metaRaw is Map<String, dynamic>
        ? ListMeta.fromJson(metaRaw)
        : const ListMeta(limit: 0, offset: 0, total: 0);
    return ListResult(data: data, meta: meta);
  }

  Future<Map<String, dynamic>> get(Object id) async {
    final path =
        '/api/${encodeUriComponent(table)}/${encodeUriComponent(id.toString())}';
    final json = await _client.requestJson('GET', path);
    return Map<String, dynamic>.from(json['data'] as Map);
  }

  Future<Map<String, dynamic>> insert(Map<String, dynamic> row) async {
    final path = '/api/${encodeUriComponent(table)}';
    final json = await _client.requestJson(
      'POST',
      path,
      body: row,
    );
    return Map<String, dynamic>.from(json['data'] as Map);
  }

  Future<Map<String, dynamic>> update(
    Object id,
    Map<String, dynamic> patch,
  ) async {
    final path =
        '/api/${encodeUriComponent(table)}/${encodeUriComponent(id.toString())}';
    final json = await _client.requestJson(
      'PATCH',
      path,
      body: patch,
    );
    return Map<String, dynamic>.from(json['data'] as Map);
  }

  Future<Map<String, dynamic>> delete(Object id) async {
    final path =
        '/api/${encodeUriComponent(table)}/${encodeUriComponent(id.toString())}';
    final json = await _client.requestJson('DELETE', path);
    return Map<String, dynamic>.from(json['data'] as Map);
  }

  /// Subscribe to change events. Returns an unsubscribe function.
  Unsubscribe subscribe(SubscribeHandler handler, {String? rowId}) {
    return _client.subscribeTable(table, handler, rowId: rowId);
  }

  /// Subscribe and wait until the server acknowledges (`subscribed` frame).
  /// Prefer this when the next statement mutates data.
  Future<Unsubscribe> subscribeReady(
    SubscribeHandler handler, {
    String? rowId,
    int timeoutMs = 5000,
  }) {
    return _client.subscribeTableReady(
      table,
      handler,
      rowId: rowId,
      timeoutMs: timeoutMs,
    );
  }

  /// Dart-idiomatic stream of change events. Cancelling the subscription
  /// unsubscribes from the table/row channel.
  Stream<ChangeEvent> changes({String? rowId}) {
    late StreamController<ChangeEvent> controller;
    Unsubscribe? unsub;
    controller = StreamController<ChangeEvent>(
      onListen: () {
        unsub = subscribe((ev) {
          if (!controller.isClosed) controller.add(ev);
        }, rowId: rowId);
      },
      onCancel: () {
        unsub?.call();
        unsub = null;
      },
    );
    return controller.stream;
  }
}

/// Encode body map as UTF-8 JSON bytes (used by client tests / helpers).
List<int> encodeJsonBody(Object? body) => utf8.encode(jsonEncode(body));
