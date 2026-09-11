import assert from "node:assert/strict";
import test from "node:test";
import type { LoomupAccessConfig } from "../access.js";

test("workspace access options are part of the public typed contract", () => {
  type Tables = { issues: unknown; notifications: unknown };
  const config = {
    profile: "workspace-project",
    projectRoles: true,
    notifications: [{ table: "notifications", allowDelete: true }],
    projectUserFields: [{ table: "issues", field: "assignee_id", nullable: true, guardRemoval: true }],
    issueParents: [{ table: "issues", field: "parent_issue_id" }],
  } as const satisfies LoomupAccessConfig<Tables>;
  assert.equal(config.notifications[0].allowDelete, true);
  const invalid: LoomupAccessConfig<Tables> = {
    profile: "workspace-project",
    // @ts-expect-error Tables outside the generated table map are rejected.
    notifications: [{ table: "missing" }],
  };
  void invalid;
});
