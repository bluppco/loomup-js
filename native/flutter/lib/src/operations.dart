import 'client.dart';
import 'realtime_url.dart';

class OperationMeta {
  final String operation;
  final String database;
  final int durationMs;
  final String contract;
  final int? rows;
  final bool replayed;

  const OperationMeta({
    required this.operation,
    required this.database,
    required this.durationMs,
    required this.contract,
    this.rows,
    this.replayed = false,
  });

  factory OperationMeta.fromJson(Map<String, dynamic> json) => OperationMeta(
        operation: json['operation'] as String,
        database: json['database'] as String,
        durationMs: (json['duration_ms'] as num).toInt(),
        contract: json['contract'] as String,
        rows: (json['rows'] as num?)?.toInt(),
        replayed: json['replayed'] == true,
      );
}

class OperationResponse<T> {
  final T data;
  final OperationMeta meta;

  const OperationResponse({required this.data, required this.meta});
}

class BatchItemResult<T> {
  final int index;
  final String status;
  final T? data;
  final String? error;

  const BatchItemResult({
    required this.index,
    required this.status,
    this.data,
    this.error,
  });
}

class JobLease<T> {
  final String id;
  final String job;
  final T payload;
  final int attempt;
  final int maxAttempts;
  final int leaseExpiresAt;
  const JobLease({required this.id, required this.job, required this.payload, required this.attempt, required this.maxAttempts, required this.leaseExpiresAt});
}

extension LoomupOperations on LoomupClient {
  Future<String> enqueueJob(String name, Object? payload, {int? runAt}) async {
    final json = await requestJson('POST', '/api/jobs/${encodeUriComponent(name)}/enqueue', body: {'payload': payload, if (runAt != null) 'run_at': runAt});
    return (json['data'] as Map)['id'] as String;
  }

  Future<JobLease<T>?> claimJob<T>(String workerId, T Function(Object? json) decode, {int leaseSeconds = 60}) async {
    final json = await requestJson('POST', '/api/jobs/claim', body: {'worker_id': workerId, 'lease_seconds': leaseSeconds});
    final raw = json['data'];
    if (raw == null) return null;
    final value = Map<String, dynamic>.from(raw as Map);
    return JobLease(
      id: value['id'] as String,
      job: value['job'] as String,
      payload: decode(value['payload']),
      attempt: (value['attempt'] as num).toInt(),
      maxAttempts: (value['max_attempts'] as num).toInt(),
      leaseExpiresAt: (value['lease_expires_at'] as num).toInt(),
    );
  }

  Future<void> heartbeatJob(String id, String workerId, {int leaseSeconds = 60}) async {
    await requestJson('POST', '/api/jobs/${encodeUriComponent(id)}/heartbeat', body: {'worker_id': workerId, 'lease_seconds': leaseSeconds});
  }

  Future<void> completeJob(String id, String workerId, Object? result) async {
    await requestJson('POST', '/api/jobs/${encodeUriComponent(id)}/complete', body: {'worker_id': workerId, 'result': result});
  }

  Future<void> failJob(String id, String workerId, String error) async {
    await requestJson('POST', '/api/jobs/${encodeUriComponent(id)}/fail', body: {'worker_id': workerId, 'error': error});
  }

  Future<OperationResponse<List<T>>> search<T>(
    String name,
    String query,
    T Function(Object? json) decode, {
    int? limit,
    int? offset,
  }) async {
    final json = await requestJson(
      'POST',
      '/api/search/${encodeUriComponent(name)}',
      body: {'query': query, if (limit != null) 'limit': limit, if (offset != null) 'offset': offset},
    );
    return OperationResponse(
      data: (json['data'] as List).map(decode).toList(),
      meta: OperationMeta.fromJson(Map<String, dynamic>.from(json['meta'] as Map)),
    );
  }

  Future<OperationResponse<T>> query<T>(
    String name,
    Object? input,
    T Function(Object? json) decode,
  ) async {
    final json = await requestJson(
      'POST',
      '/api/queries/${encodeUriComponent(name)}',
      body: input,
    );
    return OperationResponse(
      data: decode(json['data']),
      meta: OperationMeta.fromJson(Map<String, dynamic>.from(json['meta'] as Map)),
    );
  }

  Future<OperationResponse<T>> command<T>(
    String name,
    Object? input,
    T Function(Object? json) decode, {
    String? idempotencyKey,
  }) async {
    final json = await requestJson(
      'POST',
      '/api/commands/${encodeUriComponent(name)}',
      body: input,
      headers: idempotencyKey == null
          ? null
          : {'Idempotency-Key': idempotencyKey},
    );
    return OperationResponse(
      data: decode(json['data']),
      meta: OperationMeta.fromJson(Map<String, dynamic>.from(json['meta'] as Map)),
    );
  }

  Future<OperationResponse<List<BatchItemResult<T>>>> commandBatch<T>(
    String name,
    List<Object?> items,
    T Function(Object? json) decode, {
    String? idempotencyKey,
  }) async {
    final json = await requestJson(
      'POST',
      '/api/commands/${encodeUriComponent(name)}/batch',
      body: {'items': items},
      headers: idempotencyKey == null
          ? null
          : {'Idempotency-Key': idempotencyKey},
    );
    final raw = (json['data'] as List).cast<Map>();
    return OperationResponse(
      data: raw
          .map((item) => BatchItemResult<T>(
                index: (item['index'] as num).toInt(),
                status: item['status'] as String,
                data: item['data'] == null ? null : decode(item['data']),
                error: item['error'] as String?,
              ))
          .toList(),
      meta: OperationMeta.fromJson(Map<String, dynamic>.from(json['meta'] as Map)),
    );
  }
}
