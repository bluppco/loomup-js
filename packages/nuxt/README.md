# `@loomup/nuxt`

Nuxt 3/4 module for [Loomup](https://tryloomup.com): cookie sessions, Nitro server client, auth routes, and Vue composables.

## Install

```bash
npm install @loomup/client @loomup/nuxt
```

## Setup

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@loomup/nuxt"],
  loomup: {
    url: process.env.LOOMUP_URL || "http://127.0.0.1:3000",
  },
  runtimeConfig: {
    // private (server)
    loomupUrl: process.env.LOOMUP_URL || "http://127.0.0.1:3000",
    public: {
      loomupUrl: process.env.NUXT_PUBLIC_LOOMUP_URL || "http://127.0.0.1:3000",
    },
  },
});
```

## Session model

App-owned **HttpOnly** cookies on the Nuxt origin:

| Cookie | Purpose |
|--------|---------|
| `loomup-access` | JWT access token |
| `loomup-refresh` | Refresh token |

Requests to Loomup use `Authorization: Bearer`. This is not Loomup server `cookie_mode`.

## Server

```ts
// server/api/todos.get.ts
import { createServerClient, resolveLoomupUrl } from "@loomup/nuxt/server";
import { getCookie, setCookie } from "h3";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const client = createServerClient({
    url: resolveLoomupUrl(config),
    event,
    cookieAdapter: { getCookie, setCookie },
  });
  // REST only — do not call subscribe() on the server
  const { data } = await client.from("todos").select({ limit: 20 });
  return data;
});
```

The module also registers:

- Session middleware (near-expiry access refresh)
- Auth routes under `/api/auth/*` (login, register, logout, refresh, session)

## Client composables

```vue
<script setup lang="ts">
const { user, signIn, signOut } = useAuth();
const { data: todos, loading } = useLiveQuery("todos", {
  limit: 20,
  strategy: "merge",
});
const client = useLoomup();
</script>
```

## Develop

```bash
npm test   # tsc + node:test
npm run build
```

See [tryloomup.com/docs](https://tryloomup.com/docs).
