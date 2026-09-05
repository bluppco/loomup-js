# @loomup/client

TypeScript client for [Loomup](https://tryloomup.com): authentication, typed
resource CRUD, realtime subscriptions, object storage, and sync primitives for
browsers and server-side JavaScript.

## Install

```bash
npm install @loomup/client
```

## Quick start

```ts
import { createClient } from "@loomup/client";

const loomup = createClient({ url: "http://127.0.0.1:3000" });
const session = await loomup.auth.signUp({
  email: "user@example.com",
  password: "secret12",
});

if ("verification_required" in session) {
  // Show a “check your inbox” screen. No session exists yet.
  console.log(session.user.email, session.expires_in);
} else {
  await loomup.from("todos").insert({
    user_id: session.user!.id,
    title: "Ship Loomup",
    completed: false,
  });

  const unsubscribe = loomup.from("todos").subscribe((event) => {
    console.log(event.op, event.data);
  });

  unsubscribe();
}
```

Projects with verification enabled return a pending result from `signUp`.
Complete the emailed one-use link, or resend it, with:

```ts
await loomup.auth.resendVerification("user@example.com");
const session = await loomup.auth.confirmVerification(token);

await loomup.auth.requestPasswordReset("user@example.com");
await loomup.auth.confirmPasswordReset({ token, password: "new-secret12" });

// Trusted backend with a project:backend service key:
await loomup.users.invite({
  email: "teammate@example.com",
  role: "user",
  redirectTo: "https://app.example.com/acme/join/workspace-token",
});
await loomup.auth.acceptInvitation({ token, password: "secret12" });
```

Social login uses a one-use code plus a client-held verifier:

```ts
const authorization = await loomup.auth.authorizeOAuth({
  provider: "google", // or "apple" / "github"
  redirectTo: "https://app.example.com/auth/callback",
});
sessionStorage.setItem("loomup-oauth-verifier", authorization.code_verifier);
location.assign(authorization.authorization_url);

// On the registered callback route:
const code = new URL(location.href).searchParams.get("code")!;
await loomup.auth.exchangeOAuthCode({
  code,
  codeVerifier: sessionStorage.getItem("loomup-oauth-verifier")!,
});
```

React and Vue expose `signInWithOAuth` and `completeOAuthSignIn`. Next, Nuxt,
and Astro include server-owned start/callback handlers so the verifier remains
in an HttpOnly transient cookie. React Native exports `signInWithOAuth` with an
app-provided secure browser/deep-link launcher.

Browsers and modern runtimes provide `WebSocket` globally. In older Node.js
runtimes, pass a compatible implementation through `WebSocketImpl` when using
realtime subscriptions.

The client multiplexes all active subscriptions over one WebSocket. Calling a
subscription's returned cleanup function leaves that socket open while other
subscriptions remain and closes it automatically after the final subscription
is removed. Use `client.closeRealtime()` only to dispose every active realtime
subscription at once, such as during sign-out or client replacement.

With at least one active subscription, the client sends a correlated
text-frame heartbeat every 25 seconds and waits 12 seconds for the matching
pong. If an apparently open socket stops carrying application data, the client
retires it, reconnects with jitter, reauthenticates, resubscribes, and performs
the existing REST resync. Late events from the retired socket are ignored.

In browsers, an `offline` event retires the socket and pauses reconnect,
heartbeat, and subscription retry timers while retaining active subscribers.
New connections are deferred while `navigator.onLine` is `false`. An `online`
event reconnects immediately instead of waiting for an old backoff timer;
ordinary connection failures still use exponential backoff with jitter because
browser connectivity does not guarantee the server is reachable. This works
with `realtimeHeartbeat: false` too. Runtimes without browser connectivity APIs
keep their normal retry behavior, and `subscribeReady()` retains its timeout.

`client.realtimeStatus` reports `connecting`, `live`, `stale`, or
`reconnecting`; `client.onRealtimeStatus(handler)` can observe transitions.

Transport liveness does not imply that subscriptions have been acknowledged.
`client.onSubscriptionStatus(handler)` immediately supplies the current array of
`{ table, rowId?, status: "pending" | "ready" | "error", error? }` entries and
subsequent changes. Acknowledgments are correlated to the current subscription
attempt; failed or timed-out subscriptions retain their listeners and retry with
2–30 second exponential backoff. Reauthentication invalidates previous readiness.

When a `SyncStore` owns recovery, create its client with `realtimeResync: false`.
The store catches up through the durable cursor after subscription recovery,
including missed deletions. The default remains `true` for clients that depend on
legacy REST row-resync events after reconnect.
Most applications do not need either. Timing can be adjusted for tests or
proxy-specific deployments:

```ts
const loomup = createClient({
  url: "https://project.example",
  realtimeHeartbeat: { intervalMs: 25_000, timeoutMs: 12_000 },
});
```

Deploy server text-pong support before publishing a client release with this
watchdog enabled. The server's RFC WebSocket Ping/Pong remains independent.

Additional exports:

- `@loomup/client/access` — typed access-profile definitions.
- `@loomup/client/studio` — browser runtime used by Loomup Studio.

See the [Loomup SDK documentation](https://tryloomup.com/docs) for authentication,
typed resources, storage, realtime, and offline sync guides.

## License

MIT

## Notification presentation and preferences

Declare application-owned `$notifications.templates` in `loomup.schema.yaml`
(or `notifications.templates` in a Studio Resource manifest). Use a nullable
JSON `presentation_field` to save the rendered wording with each inbox row.
`$push` remains authoritative for recipients and delivery enablement. Run
`loomup generate` after adding the JSON column, review `loomup migrate --plan`,
and apply the schema after upgrading the backend.

```ts
// Trusted application server only: requires a project:backend service key.
await server.push.send({
  type: "mention",
  recipients: [recipientId],
  idempotency_key: `comment:${commentId}:${recipientId}`,
  channels: ["inbox", "push"],
  fields: { actor_id: actorId, actor_name: "Asha", issue_title: "Review design" },
});

// Signed-in application user; preserve the revision when saving.
const catalog = await client.push.catalog();
const preferences = await client.push.preferences.get();
await client.push.preferences.update({ ...preferences, preview: "hidden" });
```

`channels` defaults to both; choose only `inbox` or `push` when appropriate.
Inbox sends need all application-specific required fields. Optional literal
`content` overrides the declared type's template. Identical idempotent retries
return the original receipt; reusing a key with changed content returns 409.
Preference updates also return 409 on stale revisions. Neither recipient mutes
nor hidden previews change saved inbox content.

Use `readNotificationPresentation(row.presentation)` to read either stored JSON
or JSON text, and retain an application fallback for historical rows. The server
uses the same saved snapshot for push. Studio can edit and preview templates and
inspect per-device delivery diagnostics.

See the [notification guide](https://tryloomup.com/docs/push) for schema examples,
permissions, payload limits, fallback behavior, and the complete REST contract.
