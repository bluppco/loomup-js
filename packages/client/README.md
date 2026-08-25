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
  loomup.closeRealtime();
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
await loomup.users.invite({ email: "teammate@example.com", role: "user" });
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

Additional exports:

- `@loomup/client/access` — typed access-profile definitions.
- `@loomup/client/studio` — browser runtime used by Loomup Studio.

See the [Loomup SDK documentation](https://tryloomup.com/docs) for authentication,
typed resources, storage, realtime, and offline sync guides.

## License

MIT
