import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../cli.js";
import { compileAccess, loadAccessConfig } from "../access.js";
import { generateClientSource } from "../generate.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

test("migrate prefers the project API key and never prints it", async () => {
  const requests: Array<{ authorization?: string; body: any }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({
        authorization: request.headers.authorization,
        body: parsed,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            project_id: "project-1",
            schema_sha256: "abcdef1234567890",
            revision: parsed.dry_run ? 0 : 1,
            applied: !parsed.dry_run,
            plan: {
              actions: [
                {
                  kind: "create_table",
                  table: "todos",
                  destructive: false,
                  summary: "create table `todos`",
                },
              ],
              blockers: [],
              warnings: [],
            },
            rollback_snapshot: parsed.dry_run ? undefined : { id: "snapshot-1" },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "fixture",
      loomup: {
        url: `http://127.0.0.1:${address.port}`,
        project: "project-1",
        schema: "loomup.schema.yaml",
      },
    }),
  );
  await writeFile(join(directory, "loomup.schema.yaml"), "todos:\n  title: text\n");
  process.env.LOOMUP_API_KEY = "loomup_sk_project_deployer";
  process.env.LOOMUP_PLATFORM_TOKEN = "loomup_human_session";
  const logs = output();
  try {
    assert.equal(await runCli(["migrate"], { cwd: directory, io: logs.io }), 0);
  } finally {
    server.close();
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.authorization, "Bearer loomup_sk_project_deployer");
  assert.equal(requests[0]?.body.dry_run, true);
  assert.equal(requests[1]?.body.dry_run, false);
  assert.ok(logs.stdout.some((line) => line.includes("Applied schema revision 1")));
  assert.ok(logs.stdout.some((line) => line.includes("Generated Loomup client")));
  assert.ok(!logs.stdout.join("\n").includes("loomup_sk_project_deployer"));
  const generated = await readFile(join(directory, ".loomup", "client.ts"), "utf8");
  assert.ok(generated.includes(`"http://127.0.0.1:${address.port}/p/project-1"`));
  assert.ok(!generated.includes("loomup_sk_project_deployer"));
});

test("destructive plans stop before apply without the explicit flag", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            project_id: "p",
            schema_sha256: "abc",
            revision: 1,
            applied: false,
            plan: {
              actions: [
                {
                  kind: "rebuild_table",
                  table: "todos",
                  destructive: true,
                  summary: "remove field `todos.old`",
                },
              ],
              blockers: [],
              warnings: [],
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-loss-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      loomup: { url: `http://127.0.0.1:${address.port}`, project: "p" },
    }),
  );
  await writeFile(join(directory, "loomup.schema.yaml"), "todos:\n  title: text\n");
  process.env.LOOMUP_PLATFORM_TOKEN = "loomup_token";
  const logs = output();
  try {
    assert.equal(await runCli(["migrate"], { cwd: directory, io: logs.io }), 2);
  } finally {
    server.close();
  }
  assert.equal(requests, 1);
  assert.ok(logs.stderr.join("\n").includes("--allow-data-loss"));
});

test("link writes only non-secret project configuration", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: { project: { id: "p1" } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-link-"));
  const packagePath = join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({ name: "linked" }));
  process.env.LOOMUP_PLATFORM_TOKEN = "do-not-persist";
  const logs = output();
  try {
    assert.equal(
      await runCli(
        [
          "link",
          "--url",
          `http://127.0.0.1:${address.port}`,
          "--project",
          "p1",
        ],
        { cwd: directory, io: logs.io },
      ),
      0,
    );
  } finally {
    server.close();
  }
  const document = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(document.loomup.project, "p1");
  assert.equal(document.loomup.schema, "loomup.schema.yaml");
  assert.equal(document.loomup.access, "loomup.access.ts");
  assert.ok(!JSON.stringify(document).includes("do-not-persist"));
  const starter = await readFile(join(directory, "loomup.schema.yaml"), "utf8");
  assert.ok(starter.includes("Available field types"));
  assert.ok(starter.includes("todos:"));
});

test("link accepts a project gateway URL and infers its project", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/platform/api/projects/inferred-project");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: { project: { id: "inferred-project" } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-gateway-link-"));
  const packagePath = join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({ name: "gateway-linked" }));
  process.env.LOOMUP_PLATFORM_TOKEN = "platform-token";
  const logs = output();
  try {
    assert.equal(
      await runCli(
        ["link", "--url", `http://127.0.0.1:${address.port}/p/inferred-project`],
        { cwd: directory, io: logs.io },
      ),
      0,
    );
  } finally {
    server.close();
  }
  const document = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(document.loomup.url, `http://127.0.0.1:${address.port}`);
  assert.equal(document.loomup.project, "inferred-project");
});

test("link recognizes a project key even in the legacy platform-token variable", async () => {
  let requestMethod = "";
  let requestPath = "";
  let authorization = "";
  let requestBody: any;
  const server = createServer((request, response) => {
    requestMethod = request.method ?? "";
    requestPath = request.url ?? "";
    authorization = request.headers.authorization ?? "";
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { plan: { actions: [], blockers: [], warnings: [] } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-project-key-link-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "project-key" }));
  await writeFile(join(directory, "loomup.schema.yaml"), "todos:\n  title: text\n");
  process.env.LOOMUP_PLATFORM_TOKEN = "loomup_sk_link";
  const logs = output();
  try {
    assert.equal(
      await runCli(
        [
          "link",
          "--url",
          `http://127.0.0.1:${address.port}`,
          "--project",
          "p1",
        ],
        { cwd: directory, io: logs.io },
      ),
      0,
    );
  } finally {
    server.close();
  }
  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/platform/api/projects/p1/schema/migrate-with-access");
  assert.equal(authorization, "Bearer loomup_sk_link");
  assert.equal(requestBody.dry_run, true);
  assert.equal(requestBody.compiled_access.tables.todos.read, "auth.uid() != null");
});

test("init creates a documented schema and never overwrites it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-init-"));
  const packagePath = join(directory, "package.json");
  const schemaPath = join(directory, "db", "schema.yaml");
  await writeFile(packagePath, JSON.stringify({ name: "starter" }));
  const first = output();
  assert.equal(
    await runCli(["init", "--schema", "db/schema.yaml"], {
      cwd: directory,
      io: first.io,
    }),
    0,
  );
  const starter = await readFile(schemaPath, "utf8");
  assert.ok(starter.includes("Loomup-managed UUID `id` primary key"));
  assert.ok(starter.includes("unique: [project_id, user_id]"));
  const starterAccess = await readFile(join(directory, "loomup.access.ts"), "utf8");
  assert.ok(starterAccess.includes('profile: "authenticated"'));
  const generatedPath = join(directory, ".loomup", "client.ts");
  assert.ok((await readFile(generatedPath, "utf8")).includes("export function createDb"));
  await writeFile(schemaPath, "custom:\n  title: text\n");
  const second = output();
  assert.equal(await runCli(["init"], { cwd: directory, io: second.io }), 0);
  assert.equal(await readFile(schemaPath, "utf8"), "custom:\n  title: text\n");
  const document = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(document.loomup.schema, "db/schema.yaml");
  assert.equal(document.loomup.access, "loomup.access.ts");
  assert.ok(second.stdout.some((line) => line.includes("left it unchanged")));
});

test("credentials cannot be supplied as a command-line option", async () => {
  const logs = output();
  assert.equal(
    await runCli(["migrate", "--token", "visible-in-process-list"], {
      cwd: process.cwd(),
      io: logs.io,
    }),
    2,
  );
  assert.ok(logs.stderr.join("\n").includes("LOOMUP_API_KEY"));
});

test("platform authentication rejects every public URL override", async () => {
  process.env.LOOMUP_PLATFORM_TOKEN = "session";
  const logs = output();
  assert.equal(
    await runCli(["auth", "status", "--url", "https://example.com"], { io: logs.io }),
    2,
  );
  assert.ok(logs.stderr.join("\n").includes("unknown option: --url"));
});

test("workspace automation commands create projects and constrained project keys", async () => {
  const requests: Array<{ path?: string; authorization?: string; body?: any }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });
      response.writeHead(request.url === "/platform/api/projects" ? 201 : 201, {
        "Content-Type": "application/json",
      });
      if (request.url === "/platform/api/projects") {
        response.end(
          JSON.stringify({
            data: {
              project: { id: "project-1", name: "Created from CLI" },
              base_url: "https://tryloomup.com/p/project-1",
            },
          }),
        );
      } else {
        response.end(
          JSON.stringify({
            data: { id: "key-1", key: "loomup_sk_once", scopes: ["schema:apply"] },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  process.env.LOOMUP_WORKSPACE_API_KEY = "lbsk_workspace";
  const logs = output();
  try {
    assert.equal(
      await runCli(
        ["projects", "create", "--workspace", "workspace-1", "--name", "Created from CLI"],
        { io: logs.io, platformUrl },
      ),
      0,
    );
    assert.equal(
      await runCli(
        [
          "project-keys",
          "create",
          "--project",
          "project-1",
          "--name",
          "Schema deployer",
          "--scope",
          "schema:apply",
        ],
        { io: logs.io, platformUrl },
      ),
      0,
    );
  } finally {
    server.close();
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.authorization, "Bearer lbsk_workspace");
  assert.deepEqual(requests[0]?.body, {
    workspace_id: "workspace-1",
    name: "Created from CLI",
  });
  assert.equal(
    requests[1]?.path,
    "/platform/api/projects/project-1/studio/api-keys",
  );
  assert.deepEqual(requests[1]?.body, {
    name: "Schema deployer",
    scopes: ["schema:apply"],
  });
  assert.ok(logs.stdout.includes("loomup_sk_once"));
});

test("generate emits a ready typed project client from the standalone schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-generate-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "generated-client",
      loomup: {
        url: "https://loomup.example",
        project: "journey",
        schema: "loomup.schema.yaml",
      },
    }),
  );
  await writeFile(
    join(directory, "loomup.schema.yaml"),
    `projects:
  name: text
issues:
  project_id: projects
  title: text
  status:
    enum: [open, closed]
    default: open
  metadata: json?
  created_at: datetime
project_members:
  project_id: projects
  user_id: text
  role: text
  $indexes:
    - unique: [project_id, user_id]
`,
  );
  const logs = output();
  assert.equal(await runCli(["generate"], { cwd: directory, io: logs.io }), 0);
  const generated = await readFile(join(directory, ".loomup", "client.ts"), "utf8");

  assert.ok(generated.includes("export interface IssuesInsert"));
  const insert = generated
    .split("export interface IssuesInsert {")[1]
    ?.split("}", 1)[0];
  assert.ok(insert);
  assert.ok(!insert.includes("\n  id"));
  assert.ok(generated.includes("  project_id: string;"));
  assert.ok(generated.includes("  title: string;"));
  assert.ok(generated.includes('  status?: "open" | "closed";'));
  assert.ok(generated.includes("  metadata?: JsonValue | null;"));
  assert.ok(generated.includes("  created_at?: number;"));
  assert.ok(generated.includes('"https://loomup.example/p/journey"'));
  assert.ok(generated.includes("return createProject<TableMap, TableInsertMap, TableUpdateMap>"));

  const update = generated
    .split("export interface IssuesUpdate {")[1]
    ?.split("}", 1)[0];
  assert.ok(update);
  assert.ok(!update.includes("\n  id?:"));
  assert.ok(update.includes("title?: string;"));
});

test("generated client source never embeds a credential", () => {
  const source = generateClientSource("todos:\n  title: text\n", {
    platformUrl: "https://loomup.example",
    projectId: "project-1",
  });
  assert.ok(source.includes("export function createDb(options"));
  assert.ok(!source.includes("LOOMUP_API_KEY"));
  assert.ok(!source.includes("loomup_sk_"));
});

test("generated clients expose only declared realtime tables", () => {
  const source = generateClientSource(`
$realtime:
  tables: [issues]
issues:
  title: text
projects:
  name: text
`);
  assert.ok(source.includes('export type RealtimeTable = "issues";'));
  assert.throws(
    () => generateClientSource("$realtime:\n  tables: [missing]\nissues:\n  title: text\n"),
    /not declared as an exposed schema table/,
  );
});

test("generated clients reserve managed ids and reject custom primary keys", () => {
  assert.throws(
    () => generateClientSource("projects:\n  id: id\n  name: text\n"),
    /field `projects\.id` is managed by Loomup/,
  );
  assert.throws(
    () => generateClientSource(`
project_members:
  project_id: text
  user_id: text
  $indexes:
    - primary: [project_id, user_id]
`),
    /primary key is managed by Loomup/,
  );
});

test("generate can derive the gateway from environment-only project configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-generate-env-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "environment-client" }));
  await writeFile(join(directory, "loomup.schema.yaml"), "todos:\n  title: text\n");
  process.env.LOOMUP_URL = "https://loomup.example/p/from-url";
  const logs = output();
  assert.equal(await runCli(["generate"], { cwd: directory, io: logs.io }), 0);
  const generated = await readFile(join(directory, ".loomup", "client.ts"), "utf8");
  assert.ok(generated.includes('"https://loomup.example/p/from-url"'));
});

test("access profiles compile relationship rules without exposing the rule language", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-access-"));
  const accessPath = join(directory, "loomup.access.ts");
  await writeFile(accessPath, `
import type { LoomupAccessConfig } from "@loomup/client/access";
export default {
  profile: "workspace-project",
  memberContent: ["issues"]
} satisfies LoomupAccessConfig;
`);
  const schema = `
users:
  email: text
workspaces:
  created_by: users
memberships:
  workspace_id: workspaces
  user_id: users
  role:
    enum: [owner, admin, member]
projects:
  workspace_id: workspaces
  created_by: users
  visibility:
    enum: [public, private]
  audience:
    enum: [everyone, departments]
project_members:
  workspace_id: workspaces
  project_id: projects
  user_id: users
issues:
  workspace_id: workspaces
  project_id: projects
  title: text
`;
  const config = await loadAccessConfig(accessPath);
  const compiled = compileAccess(schema, config);
  assert.deepEqual(Object.keys(compiled.tables).sort(), [
    "issues", "memberships", "project_members", "projects", "users", "workspaces",
  ]);
  assert.match(compiled.tables.issues!.read, /exists\(memberships/);
  assert.equal(compiled.tables.issues!.subscribe, compiled.tables.issues!.read);
  assert.match(compiled.tables.issues!.read, /exists\(project_members/);
  assert.ok(!schema.includes("exists("));
});

test("the executable runs when invoked through a package-manager symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-bin-"));
  const binary = join(directory, "loomup");
  await symlink(fileURLToPath(new URL("../cli.js", import.meta.url)), binary);
  const result = spawnSync(process.execPath, [binary, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loomup migrate/);
});
