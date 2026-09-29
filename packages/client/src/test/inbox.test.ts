import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, LoomupError } from "../index.js";

test("inbox actions use one request, preserve keys and expose selection expiry", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ data: String(url).endsWith("/members") ? { ids: ["one"] } : String(url).endsWith("/selections") ? { selectionId: "snapshot", count: 10000, cutoff: 100, expiresAt: 200 } : { changed: 10000, skipped: 0, cutoff: 100, changedAt: 150 } });
  }) as typeof fetch;
  try {
    const client = createClient({ url: "https://example.test", token: "user" });
    const scope = { workspace_id: "w" };
    assert.equal((await client.inbox.select(scope)).count, 10000);
    assert.deepEqual(await client.inbox.members("snapshot", ["one", "late"], scope), ["one"]);
    const input = { action: "mark-read" as const, scope, target: { kind: "selection" as const, selectionId: "snapshot", excludedIds: ["one"] }, idempotencyKey: "operation" };
    assert.equal((await client.inbox.act(input)).changed, 10000);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2], { url: "https://example.test/inbox/actions", body: input });
    globalThis.fetch = (async () => Response.json({ error: { code: "selection_expired", message: "Select again" } }, { status: 410 })) as typeof fetch;
    await assert.rejects(client.inbox.act(input), (error: unknown) => error instanceof LoomupError && error.status === 410);
  } finally { globalThis.fetch = original; }
});
