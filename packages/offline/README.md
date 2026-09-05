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

## Event-driven synchronization

For an application whose offline store owns all realtime data recovery, pass an
existing client created with `realtimeResync: false` and configure:

```ts
const offline = await createOfflineClient({
  client,
  resources: ["checkins"],
  pollIntervalMs: 15_000,
  reconcileIntervalMs: 300_000,
  liveDebounceMs: 120,
  autoConnectivity: false, // app verifies cookie identity before resume
});
```

`reconcileIntervalMs` applies only while the transport and all required
subscriptions are healthy. Otherwise `pollIntervalMs` applies, with failed-pull
backoff up to 60 seconds (or the configured interval if larger). The new healthy
interval defaults to `pollIntervalMs`, preserving existing defaults.

Socket events are batched from the first event, with one sync in flight and at
most one queued follow-up. Reconnect recovery pulls the cursor once per cycle,
not once per subscribed table or returned row. Pagination may require several
HTTP requests within a cycle.

Call `setActive(false)` while hidden and `setActive(true)` after authenticating
on resume; use `setOnline(false)` offline. Pausing automatic work preserves
socket heartbeats and explicit `sync()`/mutation behavior. An explicit hidden
sync permits one cycle; socket invalidations cannot extend it with hidden
follow-ups. Queued automatic cycles also recheck the active state before starting.
Close the offline client on logout or teardown. Browser lifecycle ownership is optional; the
existing `autoConnectivity` default remains enabled.

Status includes `realtime`, `dataRevision`, and per-table `resourceRevisions`.
Use revisions, not idle-status transitions, to invalidate UI reads. Empty pulls
do not serialize/write the snapshot or change data revisions. Cursor-only and
mutation-queue changes remain durable without invalidating unchanged row data.

Offline-created resources should use declarative text IDs:

```toml
[resources.checkins]
id_type = "text"
```

See the [Loomup documentation](https://tryloomup.com/docs) for sync protocol and
conflict behavior.
