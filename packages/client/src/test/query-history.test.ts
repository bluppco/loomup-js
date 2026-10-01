import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../index.js";

test("queryHistory sends the public retained query contract and preserves empty continuation", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ data: [], meta: { limit: 50, through_sequence: 2005, retained_from_sequence: 1, next_before_sequence: 6 } });
  }) as typeof fetch;
  try {
    const client = createClient({ url: "https://api.test", token: "synthetic-token" });
    const first = await client.resource("labels").queryHistory({ anyOf: [{ field: "issue_id", equals: "issue" }] });
    assert.deepEqual(first.data, []); assert.equal(first.meta.next_before_sequence, 6);
    await client.from("labels").queryHistory({ anyOf: [{ field: "issue_id", equals: "issue" }],
      beforeSequence: first.meta.next_before_sequence!, throughSequence: first.meta.through_sequence, limit: 50 });
    assert.equal(calls[0]?.url, "https://api.test/api/labels/_loomup/history");
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[1]?.body, { any_of: [{ field: "issue_id", equals: "issue" }], before_sequence: 6, through_sequence: 2005, limit: 50 });
    await assert.rejects(client.resource("labels").queryHistory({ anyOf: [] }));
    await assert.rejects(client.resource("labels").queryHistory({ anyOf: [{ field: "id", equals: 1 }], beforeSequence: Number.MAX_SAFE_INTEGER + 1 }));
    await assert.rejects(client.resource("labels").queryHistory({ anyOf: [{ field: "id", equals: NaN }] }));
    await assert.rejects(client.resource("labels").queryHistory({ anyOf: [{ field: "id", equals: 1 }], limit: 501 }));
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});
