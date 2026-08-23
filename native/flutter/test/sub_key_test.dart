import 'package:loomup/loomup.dart';
import 'package:test/test.dart';

void main() {
  test('parseSubKey splits only on first hash', () {
    final a = parseSubKey('todos');
    expect(a.table, 'todos');
    expect(a.rowId, isNull);

    final b = parseSubKey('todos#1');
    expect(b.table, 'todos');
    expect(b.rowId, '1');

    final c = parseSubKey('todos#a#b#c');
    expect(c.table, 'todos');
    expect(c.rowId, 'a#b#c');

    expect(makeSubKey('todos', 'a#b'), 'todos#a#b');
    final round = parseSubKey(makeSubKey('notes', 'x#y'));
    expect(round.table, 'notes');
    expect(round.rowId, 'x#y');
  });
}
