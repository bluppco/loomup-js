import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loomupKeys,
  stableFilters,
  stableSerialize,
  invalidateTable,
  setDetail,
  removeDetail,
} from "../keys.js";

describe("stableSerialize", () => {
  it("sorts object keys for stable output", () => {
    const a = stableSerialize({ b: 1, a: 2 });
    const b = stableSerialize({ a: 2, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"b":1}');
  });

  it("sorts nested object keys", () => {
    const a = stableSerialize({ where: { z: true, a: 1 } });
    const b = stableSerialize({ where: { a: 1, z: true } });
    assert.equal(a, b);
  });
});

describe("stableFilters", () => {
  it("returns undefined for empty / missing filters", () => {
    assert.equal(stableFilters(undefined), undefined);
    assert.equal(stableFilters({}), undefined);
    assert.equal(stableFilters({ where: {} }), undefined);
  });

  it("is order-independent for where keys", () => {
    const a = stableFilters({ where: { completed: true, title: "x" } });
    const b = stableFilters({ where: { title: "x", completed: true } });
    assert.equal(a, b);
    assert.ok(a);
  });

  it("includes limit/offset/sort", () => {
    const f = stableFilters({ limit: 10, offset: 5, sort: "-id" });
    assert.ok(f);
    assert.ok(f.includes('"limit":10'));
    assert.ok(f.includes('"offset":5'));
    assert.ok(f.includes('"sort":"-id"'));
  });
});

describe("loomupKeys", () => {
  it("builds hierarchical keys", () => {
    assert.deepEqual(loomupKeys.all, ["loomup"]);
    assert.deepEqual(loomupKeys.table("todos"), ["loomup", "todos"]);
    assert.deepEqual(loomupKeys.lists("todos"), [
      "loomup",
      "todos",
      "list",
    ]);
    assert.deepEqual(loomupKeys.details("todos"), [
      "loomup",
      "todos",
      "detail",
    ]);
    assert.deepEqual(loomupKeys.detail("todos", 42), [
      "loomup",
      "todos",
      "detail",
      "42",
    ]);
    assert.deepEqual(loomupKeys.me(), ["loomup", "auth", "me"]);
  });

  it("list without filters omits trailing segment", () => {
    assert.deepEqual(loomupKeys.list("todos"), [
      "loomup",
      "todos",
      "list",
    ]);
    assert.deepEqual(loomupKeys.list("todos", {}), [
      "loomup",
      "todos",
      "list",
    ]);
  });

  it("list with filters includes stable segment", () => {
    const k1 = loomupKeys.list("todos", {
      where: { b: 1, a: 2 },
      limit: 5,
    });
    const k2 = loomupKeys.list("todos", {
      where: { a: 2, b: 1 },
      limit: 5,
    });
    assert.deepEqual(k1, k2);
    assert.equal(k1.length, 4);
    assert.equal(k1[0], "loomup");
    assert.equal(k1[1], "todos");
    assert.equal(k1[2], "list");
  });
});

describe("cache helpers", () => {
  it("invalidateTable / setDetail / removeDetail call QueryClient methods", () => {
    const calls: { op: string; key: unknown }[] = [];
    const qc = {
      invalidateQueries: (opts: { queryKey: readonly unknown[] }) => {
        calls.push({ op: "invalidate", key: opts.queryKey });
      },
      setQueryData: (key: readonly unknown[], data: unknown) => {
        calls.push({ op: "set", key: [...key, data] });
      },
      removeQueries: (opts: { queryKey: readonly unknown[] }) => {
        calls.push({ op: "remove", key: opts.queryKey });
      },
    };

    invalidateTable(qc, "todos");
    setDetail(qc, "todos", "1", { id: "1", title: "x" });
    removeDetail(qc, "todos", "1");

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], {
      op: "invalidate",
      key: ["loomup", "todos"],
    });
    assert.equal(calls[1].op, "set");
    assert.deepEqual(calls[2], {
      op: "remove",
      key: ["loomup", "todos", "detail", "1"],
    });
  });
});
