import 'dart:typed_data';

import 'client.dart';
import 'errors.dart';
import 'models.dart';
import 'realtime_url.dart';

/// Object metadata from `/storage/v1`.
class StorageObject {
  final String id;
  final String bucket;
  final String path;
  final String name;
  final String? ownerId;
  final String? contentType;
  final int size;
  final String? etag;
  final int createdAt;
  final int updatedAt;

  const StorageObject({
    required this.id,
    required this.bucket,
    required this.path,
    required this.name,
    this.ownerId,
    this.contentType,
    required this.size,
    this.etag,
    required this.createdAt,
    required this.updatedAt,
  });

  factory StorageObject.fromJson(Map<String, dynamic> json) {
    return StorageObject(
      id: json['id']?.toString() ?? '',
      bucket: json['bucket']?.toString() ?? '',
      path: json['path']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      ownerId: json['owner_id']?.toString(),
      contentType: json['content_type']?.toString(),
      size: _asInt(json['size']),
      etag: json['etag']?.toString(),
      createdAt: _asInt(json['created_at']),
      updatedAt: _asInt(json['updated_at']),
    );
  }
}

class StorageBucketInfo {
  final String name;
  final bool public;

  const StorageBucketInfo({required this.name, required this.public});

  factory StorageBucketInfo.fromJson(Map<String, dynamic> json) {
    return StorageBucketInfo(
      name: json['name']?.toString() ?? '',
      public: json['public'] == true || json['public'] == 1,
    );
  }
}

class StorageListResult {
  final List<StorageObject> data;
  final ListMeta meta;

  const StorageListResult({required this.data, required this.meta});
}

/// Encode each path segment for storage object URLs.
String encodeObjectPath(String path) {
  return path.split('/').map(encodeUriComponent).join('/');
}

/// Bucket-scoped object storage API.
class StorageBucket {
  final LoomupClient _client;
  final String bucket;

  StorageBucket(this._client, this.bucket);

  String _objectUrl(String path) =>
      '/storage/v1/${encodeUriComponent(bucket)}/object/${encodeObjectPath(path)}';

  /// Upload raw bytes. Returns object metadata.
  Future<StorageObject> upload(
    String path,
    List<int> data, {
    String? contentType = 'application/octet-stream',
    bool upsert = false,
  }) async {
    final headers = <String, String>{};
    if (contentType != null) headers['Content-Type'] = contentType;
    if (upsert) headers['x-loomup-upsert'] = 'true';
    final json = await _client.requestStorageJson(
      'POST',
      _objectUrl(path),
      body: data,
      headers: headers,
    );
    final dataMap = json['data'];
    if (dataMap is! Map) {
      throw const LoomupException('invalid storage upload response', code: 'decode_error');
    }
    return StorageObject.fromJson(Map<String, dynamic>.from(dataMap));
  }

  /// Download object bytes.
  Future<Uint8List> download(String path) async {
    final bytes = await _client.requestStorageBytes('GET', _objectUrl(path));
    return Uint8List.fromList(bytes);
  }

  /// List objects (optionally under [prefix]).
  Future<StorageListResult> list({
    String? prefix,
    int limit = 100,
    int offset = 0,
  }) async {
    final q = StringBuffer('limit=$limit&offset=$offset');
    if (prefix != null) {
      q.write('&prefix=${encodeUriComponent(prefix)}');
    }
    final json = await _client.requestStorageJson(
      'GET',
      '/storage/v1/${encodeUriComponent(bucket)}?$q',
    );
    final raw = json['data'];
    final list = <StorageObject>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          list.add(StorageObject.fromJson(Map<String, dynamic>.from(item)));
        }
      }
    }
    final metaRaw = json['meta'];
    final meta = metaRaw is Map
        ? ListMeta.fromJson(Map<String, dynamic>.from(metaRaw))
        : ListMeta(limit: limit, offset: offset, total: list.length);
    return StorageListResult(data: list, meta: meta);
  }

  /// Delete an object by path.
  Future<StorageObject> remove(String path) async {
    final json = await _client.requestStorageJson('DELETE', _objectUrl(path));
    final dataMap = json['data'];
    if (dataMap is! Map) {
      throw const LoomupException('invalid storage delete response', code: 'decode_error');
    }
    return StorageObject.fromJson(Map<String, dynamic>.from(dataMap));
  }
}

/// Top-level storage API on [LoomupClient].
class StorageAPI {
  final LoomupClient _client;
  StorageAPI(this._client);

  Future<List<StorageBucketInfo>> listBuckets() async {
    final json = await _client.requestStorageJson('GET', '/storage/v1/buckets');
    final raw = json['data'];
    final out = <StorageBucketInfo>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          out.add(StorageBucketInfo.fromJson(Map<String, dynamic>.from(item)));
        }
      }
    }
    return out;
  }

  StorageBucket from(String bucket) => StorageBucket(_client, bucket);
}

int _asInt(Object? v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse(v?.toString() ?? '') ?? 0;
}
