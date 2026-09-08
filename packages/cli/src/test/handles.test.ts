import assert from "node:assert/strict";
import { test } from "node:test";
import { generateClientSource } from "../generate.js";
const schema = `
$handles:
  memberships: { field: handle, scope: workspace_id, source: user_id.email }
users:
  email: text
workspaces:
  name: text
memberships:
  workspace_id: workspaces
  user_id: users
  handle: text
  $indexes:
    - unique: [workspace_id, handle]
`;
test("managed handles are optional on insert and required on selected rows", () => {
  const source = generateClientSource(schema);
  assert.match(source, /interface Memberships \{[^}]*handle: string;/);
  assert.match(source, /interface MembershipsInsert \{[^}]*handle\?: string;/);
});
test("rejects incomplete or unscoped handle declarations", () => {
  assert.throws(() => generateClientSource(schema.replace("user_id: users", "user_id: users?")), /source/);
  assert.throws(() => generateClientSource(schema.replace("user_id.email", "user_id.missing")), /source/);
  assert.throws(() => generateClientSource(schema.replace("unique: [workspace_id, handle]", "unique: [handle]")), /unique index/);
});
