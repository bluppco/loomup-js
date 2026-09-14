import assert from "node:assert/strict";
import test from "node:test";
import { compileAccess } from "../access.js";

const schema = `
$buckets:
  artifacts:
    public: false
users:
  auth_user_id: text
workspaces:
  name: text
workspace_members:
  workspace_id: workspaces
  user_id: users
  role: text
dashboard_invalidations:
  workspace_id: text
  revision: integer
secrets:
  value: text
`;
const config = {
  profile: "server-mediated" as const,
  realtime: {
    membership: { table: "workspace_members", workspaceField: "workspace_id", userField: "user_id" },
    identity: { table: "users", authUserIdField: "auth_user_id" },
    tables: [{ table: "dashboard_invalidations", workspaceField: "workspace_id" }],
  },
};

test("server-mediated defaults deny every user operation including new tables and buckets", () => {
  const result = compileAccess(schema, { profile: "server-mediated" });
  for (const rules of [...Object.values(result.tables), ...Object.values(result.buckets)]) {
    assert.deepEqual(new Set(Object.values(rules)), new Set(["false"]));
  }
});

test("only declared realtime reads and subscriptions use application identity membership", () => {
  const result = compileAccess(schema, config);
  const channel = result.tables.dashboard_invalidations!;
  assert.equal(channel.read, channel.subscribe);
  assert.match(channel.read, /workspace_id = row.workspace_id, user_id = lookup\(users, id, auth_user_id = auth.uid\(\)\)/);
  assert.deepEqual([channel.create, channel.update, channel.delete, channel.notify], Array(4).fill("false"));
  for (const name of ["users", "workspace_members", "workspaces", "secrets"]) {
    assert.deepEqual(new Set(Object.values(result.tables[name]!)), new Set(["false"]));
  }
  assert.equal(result.buckets.artifacts!.read, "false");
});

test("invalid mapping fails closed", () => {
  for (const mutation of [
    { identity: { ...config.realtime.identity, authUserIdField: "missing" } },
    { membership: { ...config.realtime.membership, table: "missing" } },
    { membership: { ...config.realtime.membership, userField: "role" } },
    { tables: [{ table: "missing", workspaceField: "workspace_id" }] },
    { tables: [{ table: "workspace_members", workspaceField: "workspace_id" }] },
    { tables: [...config.realtime.tables, ...config.realtime.tables] },
    { tables: [{ table: "dashboard_invalidations", workspaceField: "workspace_id) OR true" }] },
  ]) {
    assert.throws(() => compileAccess(schema, { ...config, realtime: { ...config.realtime, ...mutation } }), /invalid Loomup access config/);
  }
});
