import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, MemorySyncStorage } from "@loomup/client";
import { createOfflineClient } from "../offlineClient.js";

describe("createOfflineClient", () => {
  it("requires a URL or existing client", async () => {
    await assert.rejects(
      createOfflineClient({ resources: ["notes"] }),
      /requires url or an existing client/,
    );
  });

  it("queues and reads resource mutations while offline", async () => {
    const client = createClient({ url: "http://offline.test" });
    const offline = await createOfflineClient({
      client,
      resources: ["notes"],
      storage: new MemorySyncStorage(),
      online: false,
      live: false,
      autoConnectivity: false,
    });

    try {
      const notes = offline.from("notes");
      await notes.create(
        { id: "note-1", title: "draft" },
        { recordId: "note-1", mutationId: "device:1" },
      );
      assert.equal(notes.get("note-1")?.title, "draft");
      assert.equal(offline.status.pending, 1);

      await notes.update(
        "note-1",
        { title: "ready" },
        { mutationId: "device:2" },
      );
      assert.equal(notes.get("note-1")?.title, "ready");
      assert.equal(offline.status.pending, 2);

      await notes.remove("note-1", { mutationId: "device:3" });
      assert.equal(notes.get("note-1"), undefined);
      assert.equal(offline.status.pending, 3);
    } finally {
      offline.close();
      client.closeRealtime();
    }
  });
});
