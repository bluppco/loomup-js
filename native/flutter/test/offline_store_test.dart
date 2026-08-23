import 'dart:convert';
import 'dart:io';

import 'package:loomup/loomup.dart';
import 'package:test/test.dart';

class FixtureTransport implements SyncTransport {
  final Map<String, dynamic> fixture;
  FixtureTransport(this.fixture);

  @override
  Future<SyncBootstrapResponse> syncBootstrap(
          List<String> resources, String clientId) async =>
      SyncBootstrapResponse.fromJson(
          Map<String, dynamic>.from(fixture['bootstrap'] as Map));

  @override
  Future<SyncPullResponse> syncPull(
          int cursor, List<String> resources, String clientId) async =>
      SyncPullResponse.fromJson(
          Map<String, dynamic>.from(fixture['pull'] as Map));

  @override
  Future<SyncMutationResponse> syncMutations(
      List<SyncMutation> mutations) async {
    final results = (fixture['mutation_response']['results'] as List)
        .where((value) => (value as Map)['mutation_id'] == mutations.single.id)
        .map((value) => SyncMutationResult.fromJson(
            Map<String, dynamic>.from(value as Map)))
        .toList();
    return SyncMutationResponse(1, results);
  }
}

class FakeSQLiteDatabase implements SQLiteSyncDatabase {
  final Map<String, String> values = {};
  @override
  Future<void> execute(String sql,
      [List<Object?> parameters = const []]) async {
    if (sql.startsWith('INSERT')) {
      values[parameters[0] as String] = parameters[1] as String;
    }
    if (sql.startsWith('DELETE')) {
      values.remove(parameters[0]);
    }
  }

  @override
  Future<List<Map<String, Object?>>> query(String sql,
      [List<Object?> parameters = const []]) async {
    final value = values[parameters[0]];
    return value == null
        ? []
        : [
            {'value': value}
          ];
  }
}

void main() {
  test('SQLite adapter persists state behind the structural API', () async {
    final storage = await SQLiteSyncStorage.open(FakeSQLiteDatabase());
    await storage.setItem('state', 'durable');
    expect(await storage.getItem('state'), 'durable');
    await storage.removeItem('state');
    expect(await storage.getItem('state'), isNull);
  });

  test('shared offline v1 queue reconnect conformance', () async {
    final fixture = Map<String, dynamic>.from(
        jsonDecode(File('../../conformance/offline-v1.json').readAsStringSync())
            as Map);
    final mutations = fixture['offline_mutations'] as List;
    final store = await OfflineStore.open(
        transport: FixtureTransport(fixture), resources: ['items']);

    await store.setOnline(false);
    final create =
        SyncMutation.fromJson(Map<String, dynamic>.from(mutations[0] as Map));
    await store.create(create.resource, create.data!,
        recordId: create.recordId, mutationId: create.id);
    final update =
        SyncMutation.fromJson(Map<String, dynamic>.from(mutations[1] as Map));
    await store.update(update.resource, update.recordId!, update.data!,
        mutationId: update.id);

    expect(store.status.pending, 2);
    expect(store.status.phase, OfflinePhase.offline);
    await store.setOnline(true);

    final expected = Map<String, dynamic>.from(fixture['expected'] as Map);
    expect(store.status.cursor, expected['cursor']);
    expect(store.status.pending, expected['pending']);
    expect(store.status.conflicts, expected['conflicts']);
    expect(store.find('items').map((row) => row['id']).toList()..sort(),
        List<String>.from(expected['ids'] as List)..sort());
    await store.close();
  });
}
