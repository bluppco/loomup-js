/// Error thrown by the Loomup client for HTTP and protocol failures.
class LoomupException implements Exception {
  final String message;
  final String? code;
  final int? status;

  const LoomupException(this.message, {this.code, this.status});

  @override
  String toString() {
    final parts = <String>['LoomupException: $message'];
    if (code != null) parts.add('code=$code');
    if (status != null) parts.add('status=$status');
    return parts.join(' ');
  }
}
