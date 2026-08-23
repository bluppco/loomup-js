# Loomup Dart / Flutter SDK

Dart client for [Loomup Realtime](../../README.md) — auth, REST CRUD, and WebSocket subscriptions.

Works with **Flutter** and **pure Dart**. No Flutter framework dependency (v1).

Requires **Dart 3.0+**.

## Install

### Local path (monorepo)

In your app’s `pubspec.yaml`:

```yaml
dependencies:
  loomup:
    path: ../path/to/base/sdk/native/flutter
```

### pub.dev (after publish)

```yaml
dependencies:
  loomup: ^0.1.0
```

Then:

```bash
dart pub get
# or: flutter pub get
```

## Quick start

```dart
import 'package:loomup/loomup.dart';

final client = createClient(url: 'http://127.0.0.1:3000');

final tokens = await client.auth.signUp(
  email: 'a@b.com',
  password: 'secret12',
);

final list = await client.from('todos').select(
  where: {'completed': false}, // encoded as SQLite 0/1
  limit: 20,
);

// Prefer subscribeReady when the next line mutates data.
final unsub = await client.from('todos').subscribeReady((event) {
  print('${event.op} ${event.data}');
});
unsub();
client.closeRealtime();
```

### Stream API (Dart-idiomatic)

```dart
final sub = client.from('todos').changes().listen((event) {
  print(event.op);
});
// ...
await sub.cancel(); // unsubscribes
```

## Offline SQLite

```dart
final storage = await SQLiteSyncStorage.open(yourDatabaseAdapter);
final offline = await client.offline(resources: ['todos'], storage: storage);

await offline.create('todos', {'title': 'Queued locally'});
offline.statuses.listen((status) => print('${status.phase} ${status.pending}'));
```

Implement the small `SQLiteSyncDatabase` interface around `sqflite`, Drift, or the SQLite package already used by the app. Loomup then owns its internal state table, mutation queue, cursors, reset recovery, and realtime invalidation—no application migration or sync SQL. Use `MemorySyncStorage` in tests and call `await offline.close()` with the owning lifecycle.

## Tokens

- `setToken(...)` re-authenticates an open WebSocket and re-sends all active subscriptions.
- `setSession(...)` sets access + refresh and invokes `onTokens` when configured.
- Automatic 401 retry uses `refreshToken` when set.
- RESYNC catch-up events use Unix **seconds** for `ts`.

Persist sessions in the app layer:

```dart
final client = createClient(
  url: baseUrl,
  onTokens: (tokens) {
    // write to flutter_secure_storage / shared_preferences
  },
);
```

## Realtime reconnect

On unexpected close the SDK reconnects with **exponential backoff + full jitter** (base 1s, cap 30s), re-subscribes, then **refetches current authorized state** as `op: "RESYNC"` events. Set primary keys for custom PK tables:

```dart
client.setTablePrimaryKey('keys', 'slug');
```

## Testing / injectables

REST uses `HttpTransport` (default `PackageHttpTransport`). Realtime uses `WebSocketFactory` (default `WebSocketChannelConnection`). Inject fakes in unit tests — same role as TypeScript’s `WebSocketImpl` and Swift’s `HTTPTransport` / `WebSocketFactory`.

```bash
cd native/flutter && dart pub get && dart test
```

## API surface

| Area | Methods |
|------|---------|
| Auth | `signUp` / `register`, `signIn` / `login`, `signOut` / `logout`, `me`, `refresh` |
| CRUD | `from(table).select/get/insert/update/delete` |
| Realtime | `subscribe`, `subscribeReady`, `changes`, `onControl`, `closeRealtime` |
| Offline | `offline`, `find/get/create/update/remove`, `statuses`, `sync`, `setOnline` |

Row payloads use `Map<String, dynamic>` (dynamic tables; Dart codegen is a future enhancement).
