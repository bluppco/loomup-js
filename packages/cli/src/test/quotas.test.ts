import { test } from "node:test";
import assert from "node:assert/strict";
import { generateClientSource } from "../generate.js";
test("recognizes backend-owned declarative quota metadata without exposing internal ledgers", () => {
  const output = generateClientSource(`
$quotas:
  workspace: { scopes: workspaces, memberships: members, records: projects, entitlements: billing, bucket: files, prefixes: [entries], references: [], default_records: 3, default_bytes: 1073741824 }
workspaces:
  name: text
`);
  assert.match(output, /interface Workspaces/);
  assert.doesNotMatch(output, /quota_objects|quota_reservations/);
});
