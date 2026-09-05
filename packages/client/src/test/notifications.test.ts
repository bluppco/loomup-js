import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, LoomupError, readNotificationPresentation, type NotificationPreferences } from "../index.js";

test("notification helpers use the public contracts and preserve idempotency and revisions", async () => {
  const requests: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  const original = globalThis.fetch;
  const preferences: NotificationPreferences = { enabled: true, preview: "hidden", types: { mention: false }, muted_scopes: [{ kind: "workspace", id: "w1" }], revision: 4 };
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    return Response.json({ data: String(url).endsWith("/notifications") ? { dispatch_id: "d1", notification_ids: [], accepted: 1 } : preferences });
  }) as typeof fetch;
  try {
    const client = createClient({ url: "https://example.test", serviceKey: "service-secret" });
    const send = { type: "mention", recipients: ["u1"], idempotency_key: "event-1", channels: ["push" as const], fields: { actor: "Asha" } };
    assert.equal((await client.push.send(send)).accepted, 1);
    assert.deepEqual(requests[0]?.body, send);
    assert.equal(requests[0]?.url, "https://example.test/push/notifications");
    assert.equal(requests[0]?.headers.get("Authorization"), "Bearer service-secret");
    assert.deepEqual(await client.push.preferences.get(), preferences);
    await client.push.preferences.update(preferences);
    assert.equal(requests[2]?.method, "PUT");
    assert.deepEqual(requests[2]?.body, preferences);
    await client.push.catalog();
    assert.equal(requests[3]?.url, "https://example.test/push/catalog");
    globalThis.fetch = (async () => Response.json({ error: { code: "notification_conflict", message: "reload preferences" } }, { status: 409 })) as typeof fetch;
    await assert.rejects(client.push.preferences.update(preferences), (error: unknown) => error instanceof LoomupError && error.status === 409);
  } finally { globalThis.fetch = original; }
});

test("presentation reader accepts stored JSON and preserves legacy fallback", () => {
  const saved = { version: 1, title: "Zoë mentioned you 👋", body: "Repair café", template_revision: "one", data: { type: "mention" } };
  assert.deepEqual(readNotificationPresentation(saved), saved);
  assert.deepEqual(readNotificationPresentation(JSON.stringify(saved)), saved);
  for (const invalid of [null, "not json", [], { ...saved, version: 2 }, { ...saved, title: 42 }, { ...saved, data: { nested: {} } }]) {
    assert.equal(readNotificationPresentation(invalid), null);
  }
});
