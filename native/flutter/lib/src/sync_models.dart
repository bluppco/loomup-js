import 'client.dart';

class SyncRecord {
  final Map<String, dynamic> data;
  final int version;
  const SyncRecord(this.data, this.version);
  factory SyncRecord.fromJson(Map<String, dynamic> json) => SyncRecord(
        Map<String, dynamic>.from(json['data'] as Map),
        json['version'] as int,
      );
}

class SyncResourceSnapshot {
  final List<SyncRecord> records;
  const SyncResourceSnapshot(this.records);
  factory SyncResourceSnapshot.fromJson(Map<String, dynamic> json) =>
      SyncResourceSnapshot((json['records'] as List? ?? const [])
          .map((value) =>
              SyncRecord.fromJson(Map<String, dynamic>.from(value as Map)))
          .toList());
}

class SyncBootstrapResponse {
  final int protocolVersion;
  final String schemaVersion;
  final int cursor;
  final Map<String, SyncResourceSnapshot> resources;
  const SyncBootstrapResponse(
      this.protocolVersion, this.schemaVersion, this.cursor, this.resources);
  factory SyncBootstrapResponse.fromJson(Map<String, dynamic> json) =>
      SyncBootstrapResponse(
        json['protocol_version'] as int,
        json['schema_version'] as String,
        json['cursor'] as int,
        (json['resources'] as Map).map((key, value) => MapEntry(
            key as String,
            SyncResourceSnapshot.fromJson(
                Map<String, dynamic>.from(value as Map)))),
      );
}

class SyncEvent {
  final int sequence;
  final String resource;
  final String recordId;
  final String operation;
  final Map<String, dynamic>? after;
  const SyncEvent(
      this.sequence, this.resource, this.recordId, this.operation, this.after);
  factory SyncEvent.fromJson(Map<String, dynamic> json) => SyncEvent(
        json['sequence'] as int,
        json['resource'] as String,
        json['record_id'] as String,
        json['operation'] as String,
        json['after'] == null
            ? null
            : Map<String, dynamic>.from(json['after'] as Map),
      );
}

class SyncPullResponse {
  final int protocolVersion;
  final String schemaVersion;
  final int cursor;
  final bool hasMore;
  final List<SyncEvent> events;
  const SyncPullResponse(this.protocolVersion, this.schemaVersion, this.cursor,
      this.hasMore, this.events);
  factory SyncPullResponse.fromJson(Map<String, dynamic> json) =>
      SyncPullResponse(
        json['protocol_version'] as int,
        json['schema_version'] as String,
        json['cursor'] as int,
        json['has_more'] as bool,
        (json['events'] as List)
            .map((value) =>
                SyncEvent.fromJson(Map<String, dynamic>.from(value as Map)))
            .toList(),
      );
}

class SyncMutation {
  final String id;
  final String resource;
  final String operation;
  final String? recordId;
  final Map<String, dynamic>? data;
  final int? baseSequence;
  const SyncMutation(
      {required this.id,
      required this.resource,
      required this.operation,
      this.recordId,
      this.data,
      this.baseSequence});
  Map<String, dynamic> toJson() => {
        'id': id,
        'resource': resource,
        'operation': operation,
        if (recordId != null) 'record_id': recordId,
        if (data != null) 'data': data,
        if (baseSequence != null) 'base_sequence': baseSequence,
      };
  factory SyncMutation.fromJson(Map<String, dynamic> json) => SyncMutation(
        id: json['id'] as String,
        resource: json['resource'] as String,
        operation: json['operation'] as String,
        recordId: json['record_id'] as String?,
        data: json['data'] == null
            ? null
            : Map<String, dynamic>.from(json['data'] as Map),
        baseSequence: json['base_sequence'] as int?,
      );
}

class SyncMutationError {
  final String code;
  final String message;
  final Map<String, dynamic>? details;
  const SyncMutationError(this.code, this.message, [this.details]);
  factory SyncMutationError.fromJson(Map<String, dynamic> json) =>
      SyncMutationError(
          json['code'] as String,
          json['message'] as String,
          json['details'] == null
              ? null
              : Map<String, dynamic>.from(json['details'] as Map));
  Map<String, dynamic> toJson() => {
        'code': code,
        'message': message,
        if (details != null) 'details': details
      };
}

class SyncMutationResult {
  final String mutationId;
  final String status;
  final Map<String, dynamic>? record;
  final int? sequence;
  final SyncMutationError? error;
  const SyncMutationResult(
      this.mutationId, this.status, this.record, this.sequence, this.error);
  factory SyncMutationResult.fromJson(Map<String, dynamic> json) =>
      SyncMutationResult(
          json['mutation_id'] as String,
          json['status'] as String,
          json['record'] == null
              ? null
              : Map<String, dynamic>.from(json['record'] as Map),
          json['sequence'] as int?,
          json['error'] == null
              ? null
              : SyncMutationError.fromJson(
                  Map<String, dynamic>.from(json['error'] as Map)));
}

class SyncMutationResponse {
  final int protocolVersion;
  final List<SyncMutationResult> results;
  const SyncMutationResponse(this.protocolVersion, this.results);
  factory SyncMutationResponse.fromJson(Map<String, dynamic> json) =>
      SyncMutationResponse(
          json['protocol_version'] as int,
          (json['results'] as List)
              .map((value) => SyncMutationResult.fromJson(
                  Map<String, dynamic>.from(value as Map)))
              .toList());
}

abstract interface class SyncTransport {
  Future<SyncBootstrapResponse> syncBootstrap(
      List<String> resources, String clientId);
  Future<SyncPullResponse> syncPull(
      int cursor, List<String> resources, String clientId);
  Future<SyncMutationResponse> syncMutations(List<SyncMutation> mutations);
}

class LoomupSyncTransport implements SyncTransport {
  final LoomupClient client;
  const LoomupSyncTransport(this.client);
  String _query(List<String> resources, String clientId, [int? cursor]) =>
      'resources=${Uri.encodeQueryComponent(resources.join(','))}'
      '&client_id=${Uri.encodeQueryComponent(clientId)}&protocol_version=1'
      '${cursor == null ? '' : '&cursor=$cursor'}';
  Map<String, dynamic> _data(Map<String, dynamic> envelope) =>
      Map<String, dynamic>.from(envelope['data'] as Map);
  @override
  Future<SyncBootstrapResponse> syncBootstrap(
          List<String> resources, String clientId) async =>
      SyncBootstrapResponse.fromJson(_data(await client.requestJson(
          'GET', '/sync/v1/bootstrap?${_query(resources, clientId)}')));
  @override
  Future<SyncPullResponse> syncPull(
          int cursor, List<String> resources, String clientId) async =>
      SyncPullResponse.fromJson(_data(await client.requestJson(
          'GET', '/sync/v1/pull?${_query(resources, clientId, cursor)}')));
  @override
  Future<SyncMutationResponse> syncMutations(
          List<SyncMutation> mutations) async =>
      SyncMutationResponse.fromJson(
          _data(await client.requestJson('POST', '/sync/v1/mutations', body: {
        'protocol_version': 1,
        'mutations': mutations.map((value) => value.toJson()).toList()
      })));
}
