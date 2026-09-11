import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import initSqlJs from "sql.js";
import { parse, stringify } from "yaml";
import { compileAccess, loadAccessConfig } from "../access.js";

const schema = stringify({
  users: { email: "text" },
  workspaces: { created_by: "users" },
  memberships: { workspace_id: "workspaces", user_id: "users", role: "text", department_id: "departments?" },
  projects: { workspace_id: "workspaces", created_by: "users", visibility: "text", audience: "text" },
  project_members: { workspace_id: "workspaces", project_id: "projects", user_id: "users", role: "text" },
  departments: { workspace_id: "workspaces" },
  project_departments: { workspace_id: "workspaces", project_id: "projects", department_id: "departments" },
  issues: { workspace_id: "workspaces", project_id: "projects", assignee_id: "users?", parent_issue_id: "issues?", deleted_at: "datetime?" },
  comments: { workspace_id: "workspaces", issue_id: "issues", created_by: "users" },
  mentions: { workspace_id: "workspaces", project_id: "projects", issue_id: "issues", comment_id: "comments", user_id: "users" },
  notifications: { workspace_id: "workspaces", project_id: "projects", recipient_id: "users" },
});
const config = {
  profile: "workspace-project" as const,
  projectRoles: true,
  memberContent: ["issues"],
  comments: ["comments"],
  notifications: [{ table: "notifications", allowDelete: true }],
  projectUserFields: [
    { table: "issues", field: "assignee_id", nullable: true, guardRemoval: true },
    { table: "mentions", field: "user_id" },
  ],
  issueParents: [{ table: "issues", field: "parent_issue_id" }],
};
type Row = Record<string, string | null>;
const literal = (value: string | null | undefined) => value == null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

// Translate only Loomup relationship helpers and request variables. SQLite
// executes the compiler's actual decisions, including NULL and nested lookups.
function predicate(source: string, row: Row, user: string | null): string {
  source = source.replaceAll("auth.uid()", literal(user)).replace(/row\.([a-z_]+)/g, (_, field: string) => literal(row[field]));
  function convert(text: string): string {
    const match = /\b(exists|lookup)\(/.exec(text);
    if (!match) return text;
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, part = start, end = start;
    const args: string[] = [];
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === "'") {
        if (quoted && text[end + 1] === "'") { end++; continue; }
        quoted = !quoted;
      }
      if (quoted) continue;
      if (ch === "(") depth++;
      if (ch === ")") { if (depth === 0) { args.push(text.slice(part, end)); break; } depth--; }
      if (ch === "," && depth === 0) { args.push(text.slice(part, end)); part = end + 1; }
    }
    assert.equal(text[end], ")");
    const table = args.shift()!.trim();
    const column = match[1] === "lookup" ? args.shift()!.trim() : "1";
    const query = `SELECT ${column} FROM ${table} WHERE ${args.map(arg => `(${convert(arg)})`).join(" AND ")}`;
    return text.slice(0, match.index) + (match[1] === "exists" ? `EXISTS(${query})` : `(${query} LIMIT 1)`) + convert(text.slice(end + 1));
  }
  return convert(source).replace(/!=\s*null/gi, "IS NOT NULL").replace(/=\s*null/gi, "IS NULL");
}

test("access file loader preserves supported options and rejects malformed definitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loomup-access-"));
  try {
    const path = join(directory, "loomup.access.ts");
    await writeFile(path, `export default ${JSON.stringify(config)};`);
    assert.deepEqual(compileAccess(schema, await loadAccessConfig(path)), compileAccess(schema, config));
    for (const invalid of [
      { projectRoles: "true" }, { notifications: [{ table: "notifications", allowDelete: "true" }] },
      { projectUserFields: {} }, { projectUserFields: [{ table: "issues", field: "assignee_id", nullable: 1 }] },
      { projectUserFields: [{ table: "issues", field: "assignee_id", guardRemoval: "yes" }] },
      { issueParents: [{ table: "issues" }] },
    ]) {
      await writeFile(path, `export default ${JSON.stringify({ ...config, ...invalid })};`);
      await assert.rejects(loadAccessConfig(path), /invalid Loomup access config/);
    }
    for (const field of ["role", "workspace_id"]) {
      const shape = parse(schema); delete shape.project_members[field];
      assert.throws(() => compileAccess(stringify(shape), config), /does not exist/);
    }
    assert.throws(() => compileAccess(schema, { ...config, projectUserFields: [{ table: "issues", field: "project_id" }] }), /must reference users/);
    assert.throws(() => compileAccess(schema, { ...config, issueParents: [{ table: "issues", field: "assignee_id" }] }), /must reference itself/);
    const shape = parse(schema); delete shape.issues.deleted_at;
    assert.throws(() => compileAccess(stringify(shape), config), /deleted_at does not exist/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("roles and recipient deletion enforce current membership, scope, and ownership", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    for (const [name, fields] of Object.entries(parse(schema))) {
      db.run(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, ${Object.keys(fields as object).map(k => `${k} TEXT`).join(",")})`);
    }
    const put = (table: string, row: Row) => db.run(`INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row));
    const rules = compileAccess(schema, config).tables;
    const allowed = (table: string, op: "read" | "create" | "update" | "delete", row: Row, user: string | null = "u") => Boolean(db.exec(`SELECT (${predicate(rules[table]![op], row, user)})`)[0]!.values[0]![0]);
    const project = { id: "p", workspace_id: "w", created_by: "u", visibility: "private", audience: "departments" };
    const issue = { id: "i", workspace_id: "w", project_id: "p", assignee_id: null, parent_issue_id: null };
    const notification = { id: "n", workspace_id: "w", project_id: "p", recipient_id: "u" };
    const membership = { id: "m", workspace_id: "w", user_id: "u", role: "member" };
    const grant = { id: "g", workspace_id: "w", project_id: "p", user_id: "u", role: "owner" };
    put("projects", project); put("issues", issue); put("memberships", membership);
    for (const role of ["viewer", "editor", "owner"]) {
      put("project_members", { ...grant, role });
      assert.equal(allowed("issues", "read", issue), true);
      assert.equal(allowed("issues", "create", issue), role !== "viewer");
      assert.equal(allowed("projects", "update", project), role === "owner");
      assert.equal(allowed("notifications", "delete", notification), true);
      assert.equal(allowed("notifications", "create", notification), false);
      assert.equal(allowed("notifications", "delete", { ...notification, recipient_id: "someone-else" }), false);
      assert.equal(allowed("notifications", "delete", { ...notification, workspace_id: "other" }), false);
      assert.equal(allowed("issues", "create", { ...issue, workspace_id: "other" }), false);
    }
    db.run("DELETE FROM memberships");
    assert.equal(allowed("projects", "update", project), false, "stale owner and created_by are insufficient");
    assert.equal(allowed("notifications", "delete", notification), false);
    put("projects", { ...project, visibility: "public" });
    assert.equal(allowed("notifications", "delete", notification, null), false);
    put("projects", project); put("memberships", { ...membership, role: "admin" });
    put("memberships", { id: "target-member", workspace_id: "w", user_id: "target", role: "member" });
    const assigned = { ...issue, assignee_id: "target" };
    assert.equal(allowed("issues", "create", assigned), false);
    const targetGrant = { ...grant, id: "target-grant", user_id: "target", role: "viewer" };
    put("project_members", targetGrant);
    assert.equal(allowed("issues", "create", assigned), true);
    put("issues", assigned);
    assert.equal(allowed("project_members", "delete", targetGrant), false);
    assert.equal(allowed("project_members", "update", { ...targetGrant, user_id: "u" }), false);
    put("issues", issue);
    assert.equal(allowed("project_members", "delete", targetGrant), true);
    put("project_members", { ...targetGrant, project_id: "other" });
    assert.equal(allowed("issues", "create", assigned), false);

    const child = { ...issue, id: "child", parent_issue_id: "i" };
    assert.equal(allowed("issues", "create", child), true);
    for (const parent of ["missing", "child"]) assert.equal(allowed("issues", "create", { ...child, parent_issue_id: parent }), false);
    const parentPatches: Row[] = [{ project_id: "other" }, { workspace_id: "other" }, { deleted_at: "123" }];
    for (const patch of parentPatches) {
      put("issues", { ...issue, ...patch });
      assert.equal(allowed("issues", "create", child), false);
    }
    put("issues", issue); put("issues", child);
    assert.equal(allowed("issues", "update", child), true);
    assert.equal(allowed("issues", "update", { ...child, parent_issue_id: null }), false);
    assert.equal(allowed("issues", "update", { ...issue, parent_issue_id: "child" }), false);
    put("issues", { ...issue, deleted_at: "123" });
    assert.equal(allowed("issues", "update", child), true, "children remain editable after parent soft deletion");
  } finally { db.close(); }
});

test("legacy project grants remain supported and notification deletion is opt-in", () => {
  const shape = parse(schema); delete shape.project_members.role;
  for (const allowDelete of [undefined, false]) {
    const compiled = compileAccess(stringify(shape), { profile: "workspace-project", notifications: [{ table: "notifications", allowDelete }] });
    assert.equal(compiled.tables.notifications!.delete, "false");
    assert.doesNotMatch(compiled.tables.projects!.update, /role = 'editor'/);
  }
});
