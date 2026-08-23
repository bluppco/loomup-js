import 'package:loomup/loomup.dart';
import 'package:test/test.dart';

import 'mocks.dart';

void main() {
  test('on 401 refreshes once and retries', () async {
    final http = MockHttp();
    var access = 'old-access';
    http.handler = (method, url, auth, body) async {
      if (url.endsWith('/auth/refresh')) {
        access = 'new-access';
        return (
          body: jsonBytes({
            'data': {
              'access_token': access,
              'refresh_token': 'refresh-2',
              'token_type': 'Bearer',
              'expires_in': 900,
            },
          }),
          status: 200,
        );
      }
      if (url.endsWith('/auth/me')) {
        if (auth == 'Bearer old-access') {
          return (
            body: jsonBytes({
              'error': {'code': 'unauthorized', 'message': 'expired'},
            }),
            status: 401,
          );
        }
        if (auth == 'Bearer new-access') {
          return (
            body: jsonBytes({
              'data': {
                'id': 'u1',
                'email': 'a@b.com',
                'role': 'user',
                'disabled': false,
                'created_at': 1,
              },
            }),
            status: 200,
          );
        }
      }
      return (body: 'not found'.codeUnits, status: 404);
    };

    final c = createClient(
      url: 'http://example.test',
      token: 'old-access',
      refreshToken: 'refresh-1',
      http: http,
    );
    final me = await c.me();
    expect(me.email, 'a@b.com');
    expect(c.accessToken, 'new-access');
    expect(http.calls.any((c) => c.url.endsWith('/auth/refresh')), isTrue);
    final meCalls = http.calls.where((c) => c.url.endsWith('/auth/me')).toList();
    expect(meCalls.length, 2);
    expect(meCalls[0].auth, 'Bearer old-access');
    expect(meCalls[1].auth, 'Bearer new-access');
  });

  test('manual refresh updates tokens', () async {
    final http = MockHttp();
    http.handler = (method, url, auth, body) async {
      if (url.endsWith('/auth/refresh')) {
        return (
          body: jsonBytes({
            'data': {
              'access_token': 'a2',
              'refresh_token': 'r2',
              'token_type': 'Bearer',
              'expires_in': 60,
            },
          }),
          status: 200,
        );
      }
      return (body: 'nope'.codeUnits, status: 500);
    };
    final c = createClient(
      url: 'http://example.test',
      refreshToken: 'r1',
      http: http,
    );
    final tokens = await c.refresh();
    expect(tokens.accessToken, 'a2');
    expect(c.accessToken, 'a2');
  });

  test('refresh without token throws', () async {
    final c = createClient(url: 'http://example.test');
    try {
      await c.refresh();
      fail('expected throw');
    } on LoomupException catch (e) {
      expect(e.code, 'no_refresh');
    }
  });

  test('concurrent refresh coalesces', () async {
    final http = MockHttp();
    var refreshCount = 0;
    http.handler = (method, url, auth, body) async {
      if (url.endsWith('/auth/refresh')) {
        refreshCount += 1;
        await Future<void>.delayed(const Duration(milliseconds: 30));
        return (
          body: jsonBytes({
            'data': {
              'access_token': 'shared',
              'refresh_token': 'r2',
              'token_type': 'Bearer',
              'expires_in': 60,
            },
          }),
          status: 200,
        );
      }
      return (body: 'nope'.codeUnits, status: 500);
    };
    final c = createClient(
      url: 'http://example.test',
      refreshToken: 'r1',
      http: http,
    );
    final results = await Future.wait([c.refresh(), c.refresh(), c.refresh()]);
    expect(refreshCount, 1);
    expect(results.every((t) => t.accessToken == 'shared'), isTrue);
  });

  test('signOut clears tokens and calls onTokens null', () async {
    AuthTokens? last = const AuthTokens(
      accessToken: 'x',
      refreshToken: 'y',
      tokenType: 'Bearer',
      expiresIn: 1,
    );
    final http = MockHttp();
    http.handler = (method, url, auth, body) async {
      if (url.endsWith('/auth/logout')) {
        return (body: jsonBytes({}), status: 200);
      }
      return (body: 'nope'.codeUnits, status: 404);
    };
    final c = createClient(
      url: 'http://example.test',
      token: 'a',
      refreshToken: 'r',
      http: http,
      onTokens: (t) => last = t,
    );
    await c.auth.signOut();
    expect(c.accessToken, isNull);
    expect(c.refreshTokenValue, isNull);
    expect(last, isNull);
  });
}
