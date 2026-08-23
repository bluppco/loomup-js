import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'client.dart';
import 'errors.dart';
import 'models.dart';
import 'sync_models.dart';

abstract interface class SyncStorage {
  Future<String?> getItem(String key);
  Future<void> setItem(String key, String value);
  Future<void> removeItem(String key);
}

class MemorySyncStorage implements SyncStorage {
  final Map<String, String> _values = {};
  @override
  Future<String?> getItem(String key) async => _values[key];
  @override
  Future<void> setItem(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> removeItem(String key) async {
    _values.remove(key);
  }
}

/// Minimal interface implemented by common Flutter SQLite wrappers.
abstract interface class SQLiteSyncDatabase {
  Future<void> execute(String sql, [List<Object?> parameters = const []]);
  Future<List<Map<String, Object?>>> query(String sql,
      [List<Object?> parameters = const []]);
}

class SQLiteSyncStorage implements SyncStorage {
  final SQLiteSyncDatabase database;
  SQLiteSyncStorage._(this.database);
  static Future<SQLiteSyncStorage> open(SQLiteSyncDatabase database) async {
    await database.execute(
        'CREATE TABLE IF NOT EXISTS loomup_sync_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    return SQLiteSyncStorage._(database);
  }

  @override
  Future<String?> getItem(String key) async {
    final rows = await database
        .query('SELECT value FROM loomup_sync_store WHERE key = ?', [key]);
    return rows.isEmpty ? null : rows.first['value'] as String?;
  }

  @override
  Future<void> setItem(String key, String value) => database.execute(
      'INSERT INTO loomup_sync_store(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
      [key, value, DateTime.now().millisecondsSinceEpoch ~/ 1000]);
  @override
  Future<void> removeItem(String key) =>
      database.execute('DELETE FROM loomup_sync_store WHERE key = ?', [key]);
}

enum OfflinePhase { idle, syncing, offline, conflict, error }

class OfflineStatus {
  final OfflinePhase phase;
  final bool online;
  final int cursor;
  final int pending;
  final int conflicts;
  final String? lastError;
  const OfflineStatus(this.phase, this.online, this.cursor, this.pending,
      this.conflicts, this.lastError);
}

class OfflineConflict {
  final SyncMutation mutation;
  final SyncMutationError error;
  const OfflineConflict(this.mutation, this.error);
}

String _id() =>
    '${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 32)}';

class OfflineStore {
  final SyncTransport transport;
  final List<String> resources;
  final SyncStorage storage;
  final String storageKey;
  final Map<String, String> primaryKeys;
  final _statuses = StreamController<OfflineStatus>.broadcast();
  final Map<String, dynamic> _state;
  bool _online;
  OfflinePhase _phase;
  String? _lastError;
  Future<void> _serial = Future.value();
  List<Unsubscribe> _realtimeUnsubscribes = [];

  OfflineStore._(this.transport, this.resources, this.storage, this.storageKey,
      this.primaryKeys, this._state, this._online)
      : _phase = _online ? OfflinePhase.idle : OfflinePhase.offline;

  static Future<OfflineStore> open(
      {required SyncTransport transport,
      required List<String> resources,
      SyncStorage? storage,
      String storageKey = 'loomup.sync.v1',
      Map<String, String> primaryKeys = const {},
      bool online = true}) async {
    if (resources.isEmpty) {
      throw ArgumentError('OfflineStore requires resources');
    }
    final target = storage ?? MemorySyncStorage();
    final saved = await target.getItem(storageKey);
    final state = saved == null
        ? <String, dynamic>{
            'format': 1,
            'client_id': _id(),
            'schema_version': '',
            'cursor': 0,
            'rows': <String, dynamic>{},
            'pending': <dynamic>[],
            'conflicts': <dynamic>[],
          }
        : Map<String, dynamic>.from(jsonDecode(saved) as Map);
    final store = OfflineStore._(transport, {...resources}.toList()..sort(),
        target, storageKey, primaryKeys, state, online);
    if (online) await store.sync();
    return store;
  }

  Stream<OfflineStatus> get statuses => _statuses.stream;
  OfflineStatus get status => OfflineStatus(
      _phase,
      _online,
      _state['cursor'] as int,
      (_state['pending'] as List).length,
      (_state['conflicts'] as List).length,
      _lastError);
  List<OfflineConflict> get conflicts =>
      (_state['conflicts'] as List).map((value) {
        final item = Map<String, dynamic>.from(value as Map);
        return OfflineConflict(
            SyncMutation.fromJson(
                Map<String, dynamic>.from(item['mutation'] as Map)),
            SyncMutationError.fromJson(
                Map<String, dynamic>.from(item['error'] as Map)));
      }).toList();
  String _pk(String resource) => primaryKeys[resource] ?? 'id';
  void _require(String resource) {
    if (!resources.contains(resource)) {
      throw ArgumentError('$resource is not synchronized');
    }
  }

  Map<String, dynamic> _rows(String resource) => Map<String, dynamic>.from(
      (_state['rows'] as Map)[resource] as Map? ?? const {});
  void _setRows(String resource, Map<String, dynamic> rows) =>
      (_state['rows'] as Map)[resource] = rows;
  void _notify() {
    if (!_statuses.isClosed) _statuses.add(status);
  }

  Future<void> _persist() => storage.setItem(storageKey, jsonEncode(_state));
  Future<T> _locked<T>(Future<T> Function() action) {
    final result = _serial.then((_) => action());
    _serial = result.then<void>((_) {}, onError: (_) {});
    return result;
  }

  List<Map<String, dynamic>> find(String resource) {
    _require(resource);
    return _rows(resource)
        .values
        .map(
            (value) => Map<String, dynamic>.from((value as Map)['data'] as Map))
        .toList();
  }

  Map<String, dynamic>? get(String resource, String id) {
    _require(resource);
    final value = _rows(resource)[id];
    return value == null
        ? null
        : Map<String, dynamic>.from((value as Map)['data'] as Map);
  }

  Future<Map<String, dynamic>> create(
          String resource, Map<String, dynamic> data,
          {String? recordId, String? mutationId}) =>
      _locked(() async {
        _require(resource);
        final id = recordId ?? data[_pk(resource)]?.toString() ?? _id();
        final row = {...data, _pk(resource): id};
        final rows = _rows(resource);
        rows[id] = {'data': row, 'version': 0};
        _setRows(resource, rows);
        (_state['pending'] as List).add(SyncMutation(
                id: mutationId ?? _id(),
                resource: resource,
                operation: 'create',
                recordId: id,
                data: row)
            .toJson());
        await _persist();
        _notify();
        if (_online) await _sync();
        return row;
      });
  Future<Map<String, dynamic>> update(
          String resource, String id, Map<String, dynamic> patch,
          {String? mutationId}) =>
      _locked(() async {
        _require(resource);
        final rows = _rows(resource);
        final old = rows[id] as Map?;
        if (old == null) throw StateError('local record not found');
        final row = {
          ...Map<String, dynamic>.from(old['data'] as Map),
          ...patch
        };
        final version = old['version'] as int;
        rows[id] = {'data': row, 'version': version};
        _setRows(resource, rows);
        (_state['pending'] as List).add(SyncMutation(
                id: mutationId ?? _id(),
                resource: resource,
                operation: 'update',
                recordId: id,
                data: patch,
                baseSequence: version)
            .toJson());
        await _persist();
        _notify();
        if (_online) await _sync();
        return row;
      });
  Future<void> remove(String resource, String id, {String? mutationId}) =>
      _locked(() async {
        _require(resource);
        final rows = _rows(resource);
        final old = rows.remove(id) as Map?;
        if (old == null) throw StateError('local record not found');
        _setRows(resource, rows);
        (_state['pending'] as List).add(SyncMutation(
                id: mutationId ?? _id(),
                resource: resource,
                operation: 'delete',
                recordId: id,
                baseSequence: old['version'] as int)
            .toJson());
        await _persist();
        _notify();
        if (_online) await _sync();
      });
  Future<void> setOnline(bool value) => _locked(() async {
        _online = value;
        _phase = value ? OfflinePhase.idle : OfflinePhase.offline;
        _notify();
        if (value) await _sync();
      });
  Future<void> sync() => _locked(_sync);

  /// Pull whenever Loomup realtime reports that a synchronized resource changed.
  void startRealtime(LoomupClient client) {
    stopRealtime();
    _realtimeUnsubscribes = resources
        .map((resource) => client.from(resource).subscribe((_) {
              unawaited(sync());
            }))
        .toList();
  }

  void stopRealtime() {
    for (final unsubscribe in _realtimeUnsubscribes) {
      unsubscribe();
    }
    _realtimeUnsubscribes = [];
  }

  Future<void> _sync() async {
    if (!_online) {
      _phase = OfflinePhase.offline;
      _notify();
      return;
    }
    _phase = OfflinePhase.syncing;
    _lastError = null;
    _notify();
    try {
      if ((_state['schema_version'] as String).isEmpty) await _bootstrap();
      final pending = _state['pending'] as List;
      while (pending.isNotEmpty) {
        final mutation = SyncMutation.fromJson(
            Map<String, dynamic>.from(pending.first as Map));
        final result =
            (await transport.syncMutations([mutation])).results.first;
        if (result.status == 'acknowledged' && result.sequence != null) {
          pending.removeAt(0);
          if (mutation.recordId != null) {
            final rows = _rows(mutation.resource);
            if (mutation.operation == 'delete') {
              rows.remove(mutation.recordId);
            } else if (result.record != null) {
              rows[mutation.recordId!] = {
                'data': result.record,
                'version': result.sequence
              };
            }
            _setRows(mutation.resource, rows);
          }
        } else if (result.status == 'conflict' || result.status == 'rejected') {
          pending.removeAt(0);
          (_state['conflicts'] as List).add({
            'mutation': mutation.toJson(),
            'error': (result.error ??
                    const SyncMutationError('conflict', 'mutation rejected'))
                .toJson()
          });
          break;
        } else {
          break;
        }
      }
      if ((_state['conflicts'] as List).isEmpty) await _pullAll();
      await _persist();
      _phase = (_state['conflicts'] as List).isEmpty
          ? OfflinePhase.idle
          : OfflinePhase.conflict;
    } on LoomupException catch (error) {
      if (error.code == 'reset_required') {
        try {
          await _bootstrap();
          await _persist();
          _phase = (_state['conflicts'] as List).isEmpty
              ? OfflinePhase.idle
              : OfflinePhase.conflict;
        } catch (resetError) {
          _phase = OfflinePhase.error;
          _lastError = resetError.toString();
        }
      } else {
        _phase = OfflinePhase.error;
        _lastError = error.toString();
      }
    } catch (error) {
      _phase = OfflinePhase.error;
      _lastError = error.toString();
    }
    _notify();
  }

  Future<void> _bootstrap() async {
    final response =
        await transport.syncBootstrap(resources, _state['client_id'] as String);
    final rows = <String, dynamic>{};
    for (final resource in resources) {
      final values = <String, dynamic>{};
      for (final record
          in response.resources[resource]?.records ?? const <SyncRecord>[]) {
        final id = record.data[_pk(resource)]?.toString();
        if (id != null) {
          values[id] = {'data': record.data, 'version': record.version};
        }
      }
      rows[resource] = values;
    }
    _state['rows'] = rows;
    _state['cursor'] = response.cursor;
    _state['schema_version'] = response.schemaVersion;
    _applyOptimisticPending();
  }

  void _applyOptimisticPending() {
    for (final value in _state['pending'] as List) {
      final mutation =
          SyncMutation.fromJson(Map<String, dynamic>.from(value as Map));
      final id = mutation.recordId;
      if (id == null) continue;
      final rows = _rows(mutation.resource);
      if (mutation.operation == 'delete') {
        rows.remove(id);
      } else if (mutation.operation == 'create' && mutation.data != null) {
        rows[id] = {'data': mutation.data, 'version': 0};
      } else if (mutation.operation == 'update' &&
          mutation.data != null &&
          rows[id] != null) {
        final current = Map<String, dynamic>.from(rows[id] as Map);
        rows[id] = {
          'data': {
            ...Map<String, dynamic>.from(current['data'] as Map),
            ...mutation.data!
          },
          'version': current['version']
        };
      }
      _setRows(mutation.resource, rows);
    }
  }

  Future<void> _pullAll() async {
    while (true) {
      final response = await transport.syncPull(
          _state['cursor'] as int, resources, _state['client_id'] as String);
      if ((_state['schema_version'] as String).isNotEmpty &&
          response.schemaVersion != _state['schema_version']) {
        await _bootstrap();
        return;
      }
      for (final event in response.events) {
        final rows = _rows(event.resource);
        final current = rows[event.recordId] as Map?;
        if (current != null && (current['version'] as int) >= event.sequence) {
          continue;
        }
        if (event.operation == 'DELETE' || event.after == null) {
          rows.remove(event.recordId);
        } else {
          rows[event.recordId] = {
            'data': event.after,
            'version': event.sequence
          };
        }
        _setRows(event.resource, rows);
      }
      _state['cursor'] = response.cursor;
      _state['schema_version'] = response.schemaVersion;
      if (!response.hasMore) break;
    }
  }

  Future<void> close() async {
    stopRealtime();
    await _serial;
    await _statuses.close();
  }
}

extension LoomupOfflineClient on LoomupClient {
  Future<OfflineStore> offline(
          {required List<String> resources,
          SyncStorage? storage,
          String storageKey = 'loomup.sync.v1',
          Map<String, String> primaryKeys = const {},
          bool online = true}) =>
      _openOffline(resources, storage, storageKey, primaryKeys, online);

  Future<OfflineStore> _openOffline(
      List<String> resources,
      SyncStorage? storage,
      String storageKey,
      Map<String, String> primaryKeys,
      bool online) async {
    final store = await OfflineStore.open(
        transport: LoomupSyncTransport(this),
        resources: resources,
        storage: storage,
        storageKey: storageKey,
        primaryKeys: primaryKeys,
        online: online);
    store.startRealtime(this);
    return store;
  }
}
