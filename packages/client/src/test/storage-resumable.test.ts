import { it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../index.js";

it("uploads large blobs in bounded chunks and retries a lost chunk response", async () => {
  const original = globalThis.fetch;
  const size = 8 * 1024 * 1024 + 3;
  const file = new Blob([new Uint8Array(size).fill(42)], { type: "video/mp4" });
  let offset = 0;
  let lost = false;
  const sizes: number[] = [];
  const session = () => ({ id: "upload-1", path: "movie.mp4", size, offset, chunk_size: 8 * 1024 * 1024, expires_at: 99 });
  const response = (data: unknown) => Response.json({ data });
  globalThis.fetch = (async (url, init) => {
    const address = String(url);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token");
    if (address.endsWith("/uploads")) {
      const meta = JSON.parse(String(init?.body));
      assert.equal(meta.size, size); assert.equal(meta.content_type, "video/mp4");
      return response(session());
    }
    if (init?.method === "GET") return response(session());
    if (init?.method === "PUT") {
      const body = init.body as Blob;
      sizes.push(body.size);
      const start = Number(new URL(address).searchParams.get("offset"));
      assert.equal(new Uint8Array(await body.slice(0, 1).arrayBuffer())[0], 42);
      offset = start + body.size;
      if (!lost) { lost = true; throw new TypeError("connection reset after server write"); }
      return response(session());
    }
    assert.ok(address.endsWith("/complete"));
    assert.equal(offset, size);
    return response({ id: "object-1", path: "movie.mp4", size });
  }) as typeof fetch;
  try {
    const result = await createClient({ url: "https://storage.test", token: "token" }).storage.from("files").uploadFile("movie.mp4", file);
    assert.equal(result.size, size);
    assert.deepEqual(sizes, [8 * 1024 * 1024, 8 * 1024 * 1024, 3]);
  } finally { globalThis.fetch = original; }
});

it("aborts a large upload after a permanent authorization failure without completing it", async () => {
  const original = globalThis.fetch;
  const size = 8 * 1024 * 1024 + 1;
  let aborted = false;
  globalThis.fetch = (async (url, init) => {
    if (init?.method === "DELETE") { aborted = true; return Response.json({ data: {} }); }
    if (init?.method === "PUT") return Response.json({ error: { code: "forbidden", message: "denied" } }, { status: 403 });
    assert.ok(!String(url).endsWith("/complete"));
    return Response.json({ data: { id: "s", path: "file", size, offset: 0, chunk_size: 8 * 1024 * 1024 } });
  }) as typeof fetch;
  try {
    await assert.rejects(createClient({ url: "https://storage.test" }).storage.from("files").upload("file", new Blob([new Uint8Array(size)])));
    assert.equal(aborted, true);
  } finally { globalThis.fetch = original; }
});
