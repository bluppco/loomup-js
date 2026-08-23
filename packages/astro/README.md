# @loomup/astro

Astro integration and SSR helpers for [Loomup](https://tryloomup.com), built on
`@loomup/client`.

## Install

```bash
npm install @loomup/astro @loomup/client
```

Astro 4 or newer is supported.

## Integration

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import loomup from "@loomup/astro";

export default defineConfig({
  integrations: [
    loomup({
      url: process.env.LOOMUP_URL ?? "http://127.0.0.1:3000",
    }),
  ],
});
```

## Server-side client

```astro
---
import { createServerClient } from "@loomup/astro/server";

const loomup = createServerClient(Astro.cookies, {
  url: import.meta.env.LOOMUP_URL,
});
const { data: todos } = await loomup.from("todos").select({ limit: 20 });
---

<ul>
  {todos.map((todo) => <li>{todo.title}</li>)}
</ul>
```

Package exports:

- `@loomup/astro` — Astro integration.
- `@loomup/astro/server` — cookie-backed server client and storage helpers.
- `@loomup/astro/client` — browser client for Astro islands.
- `@loomup/astro/middleware` — authentication middleware.
- `@loomup/astro/auth` — lower-level cookie authentication helpers.

See the [Astro SDK guide](https://tryloomup.com/docs) for middleware,
authenticated islands, object storage, and deployment guidance.

## License

MIT
