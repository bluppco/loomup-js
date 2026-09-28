import { it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../index.js";

it("sends backend-only email proofs and invitation idempotency without adopting a session", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; body: any; key: string | null }[] = [];
  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer backend-fixture");
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)), key: headers.get("Idempotency-Key") });
    return Response.json({ data: path.endsWith("confirm") ? { id: "proof", email: "a@example.com", purpose: "waitlist", reference: "entry", verified_at: 100 } : { id: "proof", expires_at: 86400, ok: true } });
  }) as typeof fetch;
  try {
    const client = createClient({ url: "https://example.test", serviceKey: "backend-fixture" });
    await client.emailVerifications.create({ email: "a@example.com", purpose: "waitlist", reference: "entry", redirectTo: "https://approve.so/waitlist/verify" }, { idempotencyKey: "verification-1" });
    const proof = await client.emailVerifications.confirm("proof.secret");
    await client.users.invite({ email: proof.email, redirectTo: "https://approve.so/workspaces/new" }, { idempotencyKey: "approval-1" });
    await client.users.invite({ email: proof.email });
    assert.equal(client.accessToken, undefined);
    assert.deepEqual(calls.map(c => [c.path, c.key]), [["/email-verifications", "verification-1"], ["/email-verifications/confirm", null], ["/auth/users/invite", "approval-1"], ["/auth/users/invite", null]]);
    assert.equal(calls[0].body.redirect_to, "https://approve.so/waitlist/verify");
    assert.equal(calls[1].body.token, "proof.secret");
  } finally { globalThis.fetch = original; }
});
