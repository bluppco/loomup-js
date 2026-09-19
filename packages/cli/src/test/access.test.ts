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
      { projectRoles: "true" }, { projectSoftDelete: "true" }, { notifications: [{ table: "notifications", allowDelete: "true" }] },
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
      db.run(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, ${Object.keys(fields as object).filter(k => !k.startsWith("$")).map(k => `${k} TEXT`).join(",")})`);
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


test("project soft deletion hides all descendants and linked objects without allowing restoration", async () => {
  const shape = parse(schema);
  shape.projects.deleted_at = "datetime?";
  shape.$buckets = { files: { public: false } };
  shape.entries = { workspace_id: "workspaces", project_id: "projects", status: "text", audience: "text" };
  shape.attachments = { workspace_id: "workspaces", entry_id: "entries", r2_key: "text", $indexes: [{ unique: "r2_key" }] };
  shape.other_attachments = { workspace_id: "workspaces", project_id: "projects", r2_key: "text", $indexes: [{ unique: ["r2_key"] }] };
  shape.retained = { project_key: "text", r2_key: "text", $indexes: [{ unique: "r2_key" }] };
  const source = stringify(shape);
  const options = { ...config, projectSoftDelete: true, publishedContent: [{ table: "entries" }], serviceOnly: ["retained"], objects: [{ table: "attachments" }, { table: "other_attachments" }, { table: "retained", projectField: "project_key" }] };
  const policies = compileAccess(source, options);
  const directory = await mkdtemp(join(tmpdir(), "loomup-soft-delete-"));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    const path = join(directory, "loomup.access.ts");
    await writeFile(path, `export default ${JSON.stringify(options)};`);
    assert.deepEqual(compileAccess(source, await loadAccessConfig(path)), policies);
    assert.deepEqual(compileAccess(source, { ...options, projectSoftDelete: false }), compileAccess(source, { ...options, projectSoftDelete: undefined }));
    for (const invalid of [undefined, "text?", "datetime"]) {
      const invalidShape = parse(source);
      if (invalid === undefined) delete invalidShape.projects.deleted_at;
      else invalidShape.projects.deleted_at = invalid;
      assert.throws(() => compileAccess(stringify(invalidShape), options), /must be a nullable datetime/);
    }
    const ambiguousShape = parse(source); delete ambiguousShape.attachments.$indexes;
    assert.throws(() => compileAccess(stringify(ambiguousShape), options), /requires a single-field unique index/);
    for (const [name, fields] of Object.entries(shape)) {
      if (!name.startsWith("$")) db.run(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, ${Object.keys(fields as object).filter(k => !k.startsWith("$")).map(k => `${k} TEXT`).join(",")})`);
    }
    const put = (table: string, row: Row) => db.run(`INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row));
    const allows = (rule: string, row: Row, user: string | null = "u") => Boolean(db.exec(`SELECT (${predicate(rule, row, user)})`)[0]!.values[0]![0]);
    const allowed = (table: string, op: keyof typeof policies.tables[string], row: Row, user: string | null = "u") => allows(policies.tables[table]![op], row, user);
    const project = { id: "p", workspace_id: "w", created_by: "u", visibility: "public", audience: "everyone", deleted_at: null };
    const membership = { id: "m", workspace_id: "w", user_id: "u", role: "member" };
    const grant = { id: "g", workspace_id: "w", project_id: "p", user_id: "u", role: "owner" };
    const issue = { id: "i", workspace_id: "w", project_id: "p", parent_issue_id: null, assignee_id: null };
    const rows: Record<string, Row> = {
      projects: project, project_members: grant,
      project_departments: { id: "pd", workspace_id: "w", project_id: "p", department_id: "d" },
      issues: issue, comments: { id: "c", workspace_id: "w", issue_id: "i", created_by: "u" },
      mentions: { id: "mention", workspace_id: "w", project_id: "p", issue_id: "i", comment_id: "c", user_id: "u" },
      notifications: { id: "n", workspace_id: "w", project_id: "p", recipient_id: "u" },
      entries: { id: "e", workspace_id: "w", project_id: "p", status: "published", audience: "everyone" },
      attachments: { id: "a", workspace_id: "w", entry_id: "e", r2_key: "file" },
    };
    put("memberships", membership);
    put("departments", { id: "d", workspace_id: "w" });
    for (const [table, row] of Object.entries(rows)) put(table, row);
    const deleted = { ...project, deleted_at: "123" };
    for (const role of ["viewer", "editor", "owner"]) {
      put("project_members", { ...grant, role });
      assert.equal(allowed("projects", "update", deleted), role === "owner", `${role}: deletion transition`);
      assert.equal(allowed("projects", "delete", project), false);
    }
    for (const role of ["admin", "owner"]) {
      put("memberships", { ...membership, role });
      assert.equal(allowed("projects", "update", deleted), true);
    }
    assert.equal(allowed("projects", "create", { ...deleted, id: "new" }), false);
    assert.equal(allowed("projects", "create", { ...project, id: "new" }), true);
    assert.equal(allowed("entries", "read", rows.entries!, null), true);
    assert.equal(allows(policies.buckets.files!.read, { path: "file", owner_id: "u" }), true);
    put("retained", { id: "retained", project_key: "p", r2_key: "archived" });
    put("projects", deleted);
    for (const role of ["member", "admin", "owner"]) {
      put("memberships", { ...membership, role });
      for (const [table, row] of Object.entries(rows)) {
        for (const op of ["read", "subscribe", "notify", "update", "delete"] as const) {
          assert.equal(allowed(table, op, table === "projects" ? deleted : row), false, `${role}: deleted ${table} ${op}`);
        }
        if (table !== "projects") assert.equal(allowed(table, "create", { ...row, id: "new" }), false, `${role}: descendant create`);
      }
      assert.equal(allowed("projects", "update", project), false, `${role}: cannot restore`);
      for (const owner_id of ["u", "other"]) for (const op of ["read", "create", "update", "delete"] as const) {
        assert.equal(allows(policies.buckets.files![op], { path: "file", owner_id }), false, `${role}: file ${op}`);
      }
    }
    assert.equal(allows(policies.buckets.files!.read, { path: "archived", owner_id: "u" }), false);
    assert.equal(allowed("retained", "read", { id: "retained", project_key: "p", r2_key: "archived" }), false);
    assert.equal(allowed("entries", "read", rows.entries!, null), false);
    assert.equal(allows(policies.buckets.files!.read, { path: "file", owner_id: "u" }, null), false);
    assert.equal(allows(policies.buckets.files!.read, { path: "unclaimed", owner_id: "u" }), true);
    put("projects", { ...project, id: "other" });
    put("entries", { ...rows.entries!, id: "other-entry", project_id: "other" });
    put("attachments", { ...rows.attachments!, id: "other-attachment", entry_id: "other-entry", r2_key: "other-file" });
    assert.equal(allows(policies.buckets.files!.read, { path: "other-file", owner_id: "u" }, null), true);
    // A live link in another metadata table must not bypass a deleted link.
    put("other_attachments", { id: "shared", workspace_id: "w", project_id: "other", r2_key: "file" });
    assert.equal(allows(policies.buckets.files!.read, { path: "file", owner_id: "u" }), false);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
