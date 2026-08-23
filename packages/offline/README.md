# `@loomup/offline`

The batteries-included browser SQLite client for Loomup sync v1.

```ts
import { createOfflineClient } from "@loomup/offline";

const offline = await createOfflineClient({
  url: "http://127.0.0.1:3000",
  database: "north-gate.sqlite",
  resources: ["attendees", "checkins"],
});

await offline.from("checkins").create({
  id: crypto.randomUUID(),
  attendee_id: "attendee-1",
  entrance_id: "north",
});

offline.subscribe(({ phase, pending }) => {
  console.log(phase, pending);
});
```

The package owns SQLite/WASM loading, the internal persistence table, IndexedDB file snapshots, connectivity events, realtime invalidation, and `SyncStore` lifecycle. Use `storage` to inject another `SyncStorage` implementation for tests or non-browser runtimes.

Offline-created resources should use declarative text IDs:

```toml
[resources.checkins]
id_type = "text"
```

See the [Loomup documentation](https://tryloomup.com/docs) for sync protocol and
conflict behavior.
