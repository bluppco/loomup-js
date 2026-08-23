import 'package:loomup/loomup.dart';
import 'package:test/test.dart';

import 'mocks.dart';

void main() {
  test('createClient stores url and token', () {
    final c = createClient(
      url: 'http://localhost:3000/',
      token: 'abc',
    );
    expect(c.url.toString(), 'http://localhost:3000');
    expect(c.accessToken, 'abc');
  });

  test('from returns query methods', () {
    final c = createClient(url: 'http://127.0.0.1:3000');
    final q = c.from('todos');
    expect(q.table, 'todos');
    expect(c.auth, isNotNull);
  });

  test('LoomupException carries code', () {
    const e = LoomupException('nope', code: 'forbidden', status: 403);
    expect(e.code, 'forbidden');
    expect(e.status, 403);
    expect(e.message, 'nope');
  });

  test('select encodes boolean where as 0/1', () async {
    final http = MockHttp();
    final urls = <String>[];
    http.handler = (method, url, auth, body) async {
      urls.add(url);
      return (
        body: jsonBytes({
          'data': [],
          'meta': {'limit': 10, 'offset': 0, 'total': 0},
        }),
        status: 200,
      );
    };
    final c = createClient(url: 'http://localhost:3000', http: http);
    await c.from('todos').select(where: {'completed': true}, limit: 5);
    expect(
      urls[0].contains('where%5Bcompleted%5D=1') ||
          urls[0].contains('where[completed]=1'),
      isTrue,
      reason: urls[0],
    );
    urls.clear();
    await c.from('todos').select(where: {'completed': false});
    expect(
      urls[0].contains('where%5Bcompleted%5D=0') ||
          urls[0].contains('where[completed]=0'),
      isTrue,
      reason: urls[0],
    );
  });

  test('REST-only does not require WebSocket', () async {
    final http = MockHttp();
    http.handler = (method, url, auth, body) async {
      if (url.endsWith('/auth/login')) {
        return (
          body: jsonBytes({
            'data': {
              'access_token': 'a',
              'refresh_token': 'r',
              'token_type': 'Bearer',
              'expires_in': 60,
              'user': {
                'id': 'u1',
                'email': 'a@b.com',
                'role': 'user',
                'disabled': false,
                'created_at': 1,
              },
            },
          }),
          status: 200,
        );
      }
      return (body: utf8Encode('nope'), status: 404);
    };
    // No webSocketFactory — must still work for REST.
    final c = createClient(url: 'http://localhost:3000', http: http);
    final tokens = await c.auth.signIn(email: 'a@b.com', password: 'secret12');
    expect(tokens.accessToken, 'a');
    expect(c.accessToken, 'a');
  });

  test('CRUD insert/update/delete/get', () async {
    final http = MockHttp();
    http.handler = (method, url, auth, body) async {
      if (method == 'POST' && url.endsWith('/api/todos')) {
        return (
          body: jsonBytes({
            'data': {'id': 1, 'title': 'Ship', 'completed': 0},
          }),
          status: 200,
        );
      }
      if (method == 'GET' && url.contains('/api/todos/1')) {
        return (
          body: jsonBytes({
            'data': {'id': 1, 'title': 'Ship', 'completed': 0},
          }),
          status: 200,
        );
      }
      if (method == 'PATCH') {
        return (
          body: jsonBytes({
            'data': {'id': 1, 'title': 'Done', 'completed': 1},
          }),
          status: 200,
        );
      }
      if (method == 'DELETE') {
        return (
          body: jsonBytes({
            'data': {'id': 1, 'title': 'Done', 'completed': 1},
          }),
          status: 200,
        );
      }
      return (body: utf8Encode('nope'), status: 404);
    };
    final c = createClient(url: 'http://localhost:3000', http: http);
    final inserted =
        await c.from('todos').insert({'title': 'Ship', 'completed': 0});
    expect(inserted['id'], 1);
    final got = await c.from('todos').get(1);
    expect(got['title'], 'Ship');
    final updated = await c.from('todos').update(1, {'completed': 1});
    expect(updated['completed'], 1);
    final deleted = await c.from('todos').delete(1);
    expect(deleted['id'], 1);
  });

  test('setSession updates tokens and invokes onTokens', () {
    AuthTokens? seen;
    final c = createClient(
      url: 'http://localhost:3000',
      onTokens: (t) => seen = t,
    );
    c.setSession(const SessionTokens(
      accessToken: 'a1',
      refreshToken: 'r1',
    ));
    expect(c.accessToken, 'a1');
    expect(c.refreshTokenValue, 'r1');
    expect(seen?.accessToken, 'a1');
  });

  test('HTTP error maps code and status', () async {
    final http = MockHttp();
    http.handler = (method, url, auth, body) async {
      return (
        body: jsonBytes({
          'error': {'code': 'forbidden', 'message': 'nope'},
        }),
        status: 403,
      );
    };
    final c = createClient(url: 'http://localhost:3000', http: http);
    try {
      await c.from('todos').get(1);
      fail('expected throw');
    } on LoomupException catch (e) {
      expect(e.code, 'forbidden');
      expect(e.status, 403);
      expect(e.message, 'nope');
    }
  });
}

List<int> utf8Encode(String s) => s.codeUnits;
