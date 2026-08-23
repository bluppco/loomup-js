import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/query-core";
import type { ChangeEvent } from "@loomup/client";
import { applyChangeToCache } from "../realtime.js";
import { loomupKeys } from "../keys.js";

function change(
  partial: Partial<ChangeEvent> & Pick<ChangeEvent, "op" | "id">,
): ChangeEvent {
  return {
    type: "change",
    table: "todos",
    ts: 1,
    ...partial,
  };
}

describe("applyChangeToCache", () => {
  it("INSERT/UPDATE/RESYNC set detail and invalidate lists", () => {
    const qc = new QueryClient();
    const invalidated: unknown[][] = [];
    const orig = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((opts: { queryKey: readonly unknown[] }) => {
      invalidated.push([...opts.queryKey]);
      return orig(opts as never);
    }) as typeof qc.invalidateQueries;

    applyChangeToCache(
      qc,
      "todos",
      change({
        op: "INSERT",
        id: "1",
        data: { id: "1", title: "hi" },
      }),
    );
    assert.deepEqual(qc.getQueryData(loomupKeys.detail("todos", "1")), {
      id: "1",
      title: "hi",
    });
    assert.ok(
      invalidated.some(
        (k) => k[0] === "loomup" && k[1] === "todos" && k[2] === "list",
      ),
    );

    applyChangeToCache(
      qc,
      "todos",
      change({
        op: "UPDATE",
        id: "1",
        data: { id: "1", title: "bye" },
      }),
    );
    assert.deepEqual(qc.getQueryData(loomupKeys.detail("todos", "1")), {
      id: "1",
      title: "bye",
    });

    applyChangeToCache(
      qc,
      "todos",
      change({
        op: "RESYNC",
        id: "1",
        data: { id: "1", title: "resync" },
      }),
    );
    assert.deepEqual(qc.getQueryData(loomupKeys.detail("todos", "1")), {
      id: "1",
      title: "resync",
    });
  });

  it("DELETE removes detail and invalidates lists", () => {
    const qc = new QueryClient();
    qc.setQueryData(loomupKeys.detail("todos", "9"), {
      id: "9",
      title: "x",
    });
    const invalidated: unknown[][] = [];
    const orig = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((opts: { queryKey: readonly unknown[] }) => {
      invalidated.push([...opts.queryKey]);
      return orig(opts as never);
    }) as typeof qc.invalidateQueries;

    applyChangeToCache(
      qc,
      "todos",
      change({ op: "DELETE", id: "9" }),
    );
    assert.equal(qc.getQueryData(loomupKeys.detail("todos", "9")), undefined);
    assert.ok(
      invalidated.some(
        (k) => k[0] === "loomup" && k[1] === "todos" && k[2] === "list",
      ),
    );
  });
});
