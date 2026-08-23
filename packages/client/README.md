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

await loomup.from("todos").insert({
  user_id: session.user.id,
  title: "Ship Loomup",
  completed: false,
});

const unsubscribe = loomup.from("todos").subscribe((event) => {
  console.log(event.op, event.data);
});

unsubscribe();
loomup.closeRealtime();
```

Browsers and modern runtimes provide `WebSocket` globally. In older Node.js
runtimes, pass a compatible implementation through `WebSocketImpl` when using
realtime subscriptions.

Additional exports:

- `@loomup/client/access` — typed access-profile definitions.
- `@loomup/client/studio` — browser runtime used by Loomup Studio.

See the [Loomup SDK documentation](https://tryloomup.com/docs) for authentication,
typed resources, storage, realtime, and offline sync guides.

## License

MIT
