# `@loomup/next`

Next.js helpers for [Loomup](https://tryloomup.com) — cookie sessions, App Router, Pages Router, and middleware.

Sessions are stored in **Next-owned HttpOnly cookies** (`loomup-access`, `loomup-refresh`, same as `@loomup/astro`). The app talks to Loomup with **Bearer** tokens. This is separate from Loomup server `auth.cookie_mode` (`loomup_access` / `loomup_refresh` with underscores).

## Install

```bash
npm install @loomup/next @loomup/client
```

Peer dependencies: `next` ≥ 14, `react` ≥ 18.

## Quick start (App Router)

### 1. Auth route handlers

```ts
// app/api/auth/login/route.ts
import { createAuthRouteHandlers } from "@loomup/next";

const handlers = createAuthRouteHandlers({
  url: process.env.LOOMUP_URL!,
});

export async function POST(request: Request) {
  return handlers.login(request);
}
```

Also wire `register`, `logout`, `refresh`, and `session` the same way.

### 2. Middleware

```ts
// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@loomup/next";

export async function middleware(request: NextRequest) {
  return updateSession(request, {
    url: process.env.LOOMUP_URL!,
    createResponse: () => NextResponse.next({ request }),
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

### 3. Server Components

```ts
import { cookies } from "next/headers";
import { createServerClient } from "@loomup/next";

export default async function Page() {
  const client = await createServerClient({
    url: process.env.LOOMUP_URL!,
    cookies,
  });
  const { data } = await client.from("todos").select({ limit: 20 });
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
```

### 4. Browser / realtime

```ts
"use client";
import { createBrowserClient } from "@loomup/next";

const client = createBrowserClient({
  url: process.env.NEXT_PUBLIC_LOOMUP_URL!,
  accessToken, // from RSC prop or GET /api/auth/session
});
client.from("todos").subscribe((ev) => console.log(ev));
```

### Pages Router

```ts
import { createPagesServerClient } from "@loomup/next";

export const getServerSideProps = async (ctx) => {
  const client = createPagesServerClient({
    url: process.env.LOOMUP_URL!,
    context: ctx,
  });
  const { data } = await client.from("todos").select();
  return { props: { todos: data } };
};
```

## API surface

| Export | Role |
|--------|------|
| `createServerClient` | App Router RSC / Actions / Route Handlers |
| `createPagesServerClient` | Pages `getServerSideProps` / API routes |
| `updateSession` | Middleware proactive refresh |
| `createBrowserClient` | Client Components + realtime |
| `createAuthRouteHandlers` | login / register / logout / refresh / session |
| `LoomupProvider` / `useLoomup` | Optional React context |
| Cookie helpers | `sessionCookiesFromTokens`, `readTokensFromCookies`, … |

## Docs

See [tryloomup.com/docs](https://tryloomup.com/docs).
