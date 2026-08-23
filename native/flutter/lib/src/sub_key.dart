/// Subscription keys are `table` or `table#rowId`. Split only on the first `#`
/// so row IDs that themselves contain `#` round-trip correctly.
({String table, String? rowId}) parseSubKey(String key) {
  final idx = key.indexOf('#');
  if (idx == -1) return (table: key, rowId: null);
  return (table: key.substring(0, idx), rowId: key.substring(idx + 1));
}

String makeSubKey(String table, [String? rowId]) {
  if (rowId != null && rowId.isNotEmpty) {
    return '$table#$rowId';
  }
  return table;
}
