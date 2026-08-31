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

test("migrate submits an async operation and polls its durable result", async () => {
  let applyPrefer = "";
  let polls = 0;
  const report = {
    project_id: "project-async",
    schema_sha256: "abcdef1234567890",
    revision: 2,
    applied: true,
    plan: { actions: [], blockers: [], warnings: [] },
  };
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/operations/operation-1")) {
      polls += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            id: "operation-1",
            project_id: "project-async",
            kind: "project_schema_migration",
            state: "succeeded",
            stage: "completed",
            result: report,
          },
        }),
      );
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      response.writeHead(parsed.dry_run ? 200 : 202, { "Content-Type": "application/json" });
      if (parsed.dry_run) {
        response.end(JSON.stringify({ data: { ...report, revision: 1, applied: false } }));
      } else {
        applyPrefer = String(request.headers.prefer ?? "");
        response.end(
          JSON.stringify({
            data: {
              id: "operation-1",
              project_id: "project-async",
              kind: "project_schema_migration",
              state: "queued",
              stage: "queued",
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-async-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      loomup: {
        url: `http://127.0.0.1:${address.port}`,
        project: "project-async",
        schema: "loomup.schema.yaml",
      },
    }),
  );
  await writeFile(join(directory, "loomup.schema.yaml"), "todos:\n  title: text\n");
  process.env.LOOMUP_API_KEY = "loomup_sk_async";
  const logs = output();
  try {
    assert.equal(await runCli(["migrate"], { cwd: directory, io: logs.io }), 0);
  } finally {
    server.close();
  }
  assert.equal(applyPrefer, "respond-async");
  assert.equal(polls, 1);
  assert.ok(logs.stdout.some((line) => line.includes("Applied schema revision 2")));
  assert.ok(logs.stderr.some((line) => line.includes("queued")));
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

test("data commands query the linked project with client-compatible filters and metadata", async () => {
  const requests: Array<{ path: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
    });
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url?.startsWith("/p/project-data/api/issues/issue_123")) {
        response.end(JSON.stringify({ data: { id: "issue_123", title: "Fix CLI" } }));
        return;
      }
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.searchParams.get("limit") === "1") {
        response.end(JSON.stringify({
          data: [{ id: "issue_123" }],
          meta: { limit: 1, offset: 0, total: 7, truncated: true },
        }));
        return;
      }
      response.end(JSON.stringify({
        data: [
          { id: "issue_123", title: "Fix CLI" },
          { id: "issue_124", title: "Fix docs" },
        ],
        meta: { limit: 2, offset: 3, total: 7, next_cursor: "next.page" },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-data-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({
    loomup: {
      url: `http://127.0.0.1:${address.port}`,
      project: "project-data",
    },
  }));
  process.env.LOOMUP_API_KEY = "loomup_sk_data_reader";
  const listLogs = output();
  const countLogs = output();
  const getLogs = output();
  try {
    assert.equal(await runCli([
      "data", "list", "issues",
      "--where", "status=open",
      "--where", "archived=false",
      "--filter", "priority.gte=2",
      "--filter", "title.startsWith=Fix",
      "--select", "id,title",
      "--sort", "-created_at",
      "--limit", "2",
      "--offset", "3",
      "--json",
    ], { cwd: directory, io: listLogs.io }), 0);
    assert.equal(await runCli([
      "data", "count", "issues", "--where", "status=open", "--json",
    ], { cwd: directory, io: countLogs.io }), 0);
    assert.equal(await runCli([
      "data", "get", "issues", "issue_123", "--json",
    ], { cwd: directory, io: getLogs.io }), 0);
  } finally {
    server.close();
  }

  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.authorization === "Bearer loomup_sk_data_reader"));
  const listUrl = new URL(requests[0]!.path, "http://localhost");
  assert.equal(listUrl.pathname, "/p/project-data/api/issues");
  assert.equal(listUrl.searchParams.get("where[status]"), "open");
  assert.equal(listUrl.searchParams.get("where[archived]"), "0");
  assert.equal(listUrl.searchParams.get("filter[priority][gte]"), "2");
  assert.equal(listUrl.searchParams.get("filter[title][starts_with]"), "Fix");
  assert.equal(listUrl.searchParams.get("select"), "id,title");
  assert.equal(listUrl.searchParams.get("sort"), "-created_at");
  assert.equal(listUrl.searchParams.get("limit"), "2");
  assert.equal(listUrl.searchParams.get("offset"), "3");
  assert.equal(JSON.parse(listLogs.stdout.join("\n")).meta.total, 7);
  assert.equal(JSON.parse(countLogs.stdout.join("\n")).total, 7);
  assert.ok(countLogs.stderr.join("\n").includes("lower bound"));
  assert.equal(JSON.parse(getLogs.stdout.join("\n")).data.id, "issue_123");
});

test("logged-in data debugging defaults to hosted manager access and discovers project Resources", async () => {
  const requests: Array<{ path: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname.endsWith("/studio/schema")) {
        response.end(JSON.stringify({ data: {
          manifest: { resources: { issues: { fields: { title: {}, status: {} } } } },
          discovered_resources: [
            { name: "issues", columns: [{ name: "id" }, { name: "title" }, { name: "status" }] },
            { name: "logs", columns: [{ name: "id" }, { name: "message" }] },
          ],
          archived_resources: ["archived_notes"],
        } }));
        return;
      }
      if (url.pathname.endsWith("/records/issue_1")) {
        response.end(JSON.stringify({ data: { id: "issue_1", title: "First", status: "open" } }));
        return;
      }
      if (url.pathname.includes("/resources/logs/records")) {
        response.end(JSON.stringify({
          data: [{ id: "log_1", message: "ready" }],
          meta: { limit: 1, offset: 0, total: 5 },
        }));
        return;
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const filtered = url.searchParams.get("where[status]") === "open";
      const rows = filtered
        ? [
            { id: "issue_1", title: "First", status: "open" },
            { id: "issue_2", title: "Second", status: "open" },
            { id: "issue_3", title: "Third", status: "open" },
          ]
        : [{ id: "issue_1", title: "First", status: "open" }];
      const limit = Number(url.searchParams.get("limit") ?? 50);
      response.end(JSON.stringify({
        data: rows.slice(offset, offset + limit),
        meta: { limit, offset, total: filtered ? 3 : 7 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-manager-data-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "manager-data" }));
  process.env.LOOMUP_PLATFORM_TOKEN = "human-session";
  delete process.env.LOOMUP_API_KEY;
  const resourcesLogs = output();
  const summaryLogs = output();
  const listLogs = output();
  const tableLogs = output();
  const getLogs = output();
  try {
    assert.equal(await runCli([
      "data", "resources", "--project", "project-manager", "--json",
    ], { cwd: directory, io: resourcesLogs.io, platformUrl }), 0);
    assert.equal(await runCli([
      "data", "summary", "--project", "project-manager", "--json",
    ], { cwd: directory, io: summaryLogs.io, platformUrl }), 0);
    assert.equal(await runCli([
      "data", "list", "issues", "--project", "project-manager",
      "--where", "status=open", "--limit", "2", "--all", "--json",
    ], { cwd: directory, io: listLogs.io, platformUrl }), 0);
    assert.equal(await runCli([
      "data", "list", "issues", "--project", "project-manager", "--limit", "1",
    ], { cwd: directory, io: tableLogs.io, platformUrl }), 0);
    assert.equal(await runCli([
      "data", "get", "issues", "issue_1", "--project", "project-manager", "--jsonl",
    ], { cwd: directory, io: getLogs.io, platformUrl }), 0);
  } finally {
    server.close();
  }

  const resources = JSON.parse(resourcesLogs.stdout.join("\n"));
  assert.deepEqual(resources.map((resource: { name: string }) => resource.name), ["issues", "logs"]);
  const summary = JSON.parse(summaryLogs.stdout.join("\n"));
  assert.deepEqual(
    summary.resources.map((resource: { resource: string; records: number }) => [resource.resource, resource.records]),
    [["issues", 7], ["logs", 5]],
  );
  assert.equal(JSON.parse(listLogs.stdout.join("\n")).data.length, 3);
  assert.ok(tableLogs.stdout[0]?.includes("id"));
  assert.ok(tableLogs.stdout.some((line) => line.includes("Showing 1 of 7")));
  assert.equal(JSON.parse(getLogs.stdout.join("\n")).id, "issue_1");
  assert.ok(requests.every((request) => request.authorization === "Bearer human-session"));
  assert.ok(requests.every((request) => request.path.startsWith("/platform/api/projects/project-manager/studio/")));
  assert.equal(
    requests.filter((request) => request.path.includes("where%5Bstatus%5D=open")).length,
    2,
    "--all should continue the filtered manager query by offset",
  );
});

test("data commands reject unsafe or ambiguous queries before making a request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-data-validation-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({
    loomup: { url: "https://tryloomup.com", project: "project-data" },
  }));
  process.env.LOOMUP_API_KEY = "loomup_sk_data_reader";

  const cursorLogs = output();
  assert.equal(await runCli([
    "data", "list", "issues", "--cursor", "next.page", "--limit", "20",
  ], { cwd: directory, io: cursorLogs.io }), 2);
  assert.ok(cursorLogs.stderr.join("\n").includes("--cursor cannot be combined"));

  const filterLogs = output();
  assert.equal(await runCli([
    "data", "list", "issues", "--filter", "priority.unknown=2",
  ], { cwd: directory, io: filterLogs.io }), 2);
  assert.ok(filterLogs.stderr.join("\n").includes("unknown filter operator"));

  const resourceLogs = output();
  assert.equal(await runCli([
    "data", "list", "_secrets",
  ], { cwd: directory, io: resourceLogs.io }), 2);
  assert.ok(resourceLogs.stderr.join("\n").includes("resource must start"));
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

test("saved login discovers a workspace and creates and links a project", async () => {
  const requests: Array<{ method?: string; path?: string; authorization?: string; body?: any }> = [];
  let packagePath = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });
      if (request.url === "/platform/api/auth/login") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "loomup_platform_session=saved-session; Path=/; HttpOnly",
        });
        response.end(JSON.stringify({ data: { ok: true } }));
      } else if (request.url === "/platform/api/workspaces") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          data: [{ id: "workspace-1", name: "Personal", slug: "personal", owner_user_id: "user-1", created_at: 1 }],
        }));
      } else if (request.url === "/platform/api/projects") {
        await writeFile(packagePath, JSON.stringify({
          name: "onboarding",
          scripts: { preserved_during_provisioning: "yes" },
        }));
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          data: {
            project: { id: "project-1", workspace_id: "workspace-1", name: "My App", slug: "my-app" },
            base_url: `${platformUrl}/p/project-1`,
          },
        }));
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-onboarding-"));
  const credentialPath = join(directory, "credentials.json");
  packagePath = join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({ name: "onboarding" }));
  const loginLogs = output();
  const createLogs = output();
  try {
    assert.equal(await runCli(["auth", "login"], {
      io: loginLogs.io,
      platformUrl,
      credentialPath,
      loginCredentials: async () => ({ email: "dev@example.com", password: "secret12" }),
    }), 0);
    assert.ok(loginLogs.stdout.join("\n").includes("workspace-1\tPersonal"));
    assert.equal(await runCli(["projects", "create", "--name", "My App", "--link", "--json"], {
      cwd: directory,
      io: createLogs.io,
      platformUrl,
      credentialPath,
      interactive: false,
    }), 0);
  } finally {
    server.close();
  }
  assert.equal(requests.filter((request) => request.path === "/platform/api/workspaces").length, 2);
  const createRequest = requests.find((request) => request.method === "POST" && request.path === "/platform/api/projects");
  assert.equal(createRequest?.authorization, "Bearer saved-session");
  assert.deepEqual(createRequest?.body, { workspace_id: "workspace-1", name: "My App" });
  const result = JSON.parse(createLogs.stdout.join("\n"));
  assert.equal(result.local_link.package_path, join(directory, "package.json"));
  const document = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(document.scripts.preserved_during_provisioning, "yes");
  assert.equal(document.loomup.url, platformUrl);
  assert.equal(document.loomup.project, "project-1");
  assert.ok((await readFile(join(directory, ".loomup", "client.ts"), "utf8")).includes("/p/project-1"));
});

test("login remains successful when follow-up workspace discovery fails", async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url === "/platform/api/auth/login") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "loomup_platform_session=saved-session; Path=/; HttpOnly",
        });
        response.end(JSON.stringify({ data: { ok: true } }));
      } else {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-login-warning-"));
  const credentialPath = join(directory, "credentials.json");
  const logs = output();
  try {
    assert.equal(await runCli(["auth", "login"], {
      io: logs.io,
      platformUrl,
      credentialPath,
      loginCredentials: async () => ({ email: "dev@example.com", password: "secret12" }),
    }), 0);
  } finally {
    server.close();
  }
  assert.ok(logs.stdout.join("\n").includes("Authenticated"));
  assert.ok(logs.stderr.join("\n").includes("workspace discovery failed"));
  assert.equal(JSON.parse(await readFile(credentialPath, "utf8")).token, "saved-session");
});

test("workspace commands expose empty state and create with the human session", async () => {
  const requests: Array<{ method?: string; authorization?: string; body?: any }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });
      response.writeHead(request.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: request.method === "POST"
        ? { id: "workspace-1", name: "Acme", slug: "acme", owner_user_id: "user-1", created_at: 1 }
        : [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  process.env.LOOMUP_PLATFORM_TOKEN = "human-session";
  const listLogs = output();
  const missingLogs = output();
  const createLogs = output();
  try {
    assert.equal(await runCli(["workspaces", "list"], { io: listLogs.io, platformUrl }), 0);
    assert.equal(await runCli(["projects", "create", "--name", "Missing"], {
      io: missingLogs.io, platformUrl, interactive: false,
    }), 2);
    assert.equal(await runCli(["workspaces", "create", "--name", "Acme", "--json"], { io: createLogs.io, platformUrl }), 0);
  } finally {
    server.close();
  }
  assert.ok(listLogs.stdout.join("\n").includes("No workspaces found"));
  assert.ok(missingLogs.stderr.join("\n").includes("workspaces create --name"));
  assert.equal(JSON.parse(createLogs.stdout.join("\n")).id, "workspace-1");
  assert.deepEqual(requests.find((request) => request.method === "POST")?.body, { name: "Acme" });
  assert.ok(requests.every((request) => request.authorization === "Bearer human-session"));
});

test("project creation selects among multiple workspaces only when interactive", async () => {
  const projectBodies: any[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [
        { id: "workspace-1", name: "One", slug: "one", owner_user_id: "user-1", created_at: 1 },
        { id: "workspace-2", name: "Two", slug: "two", owner_user_id: "user-1", created_at: 2 },
      ] }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      projectBodies.push(JSON.parse(body));
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: {
        project: { id: "project-2", workspace_id: "workspace-2", name: "Selected", slug: "selected" },
        base_url: `${platformUrl}/p/project-2`,
      } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  process.env.LOOMUP_PLATFORM_TOKEN = "human-session";
  const nonInteractive = output();
  const jsonLogs = output();
  const interactive = output();
  let jsonPrompted = false;
  try {
    assert.equal(await runCli(["projects", "create", "--name", "Blocked"], {
      io: nonInteractive.io, platformUrl, interactive: false,
    }), 2);
    assert.ok(nonInteractive.stderr.join("\n").includes("workspace-1"));
    assert.ok(nonInteractive.stderr.join("\n").includes("workspace-2"));
    assert.equal(await runCli(["projects", "create", "--name", "JSON", "--json"], {
      io: jsonLogs.io,
      platformUrl,
      interactive: true,
      workspaceChoice: async () => {
        jsonPrompted = true;
        return "workspace-1";
      },
    }), 2);
    assert.equal(await runCli(["projects", "create", "--name", "Selected"], {
      io: interactive.io,
      platformUrl,
      interactive: true,
      workspaceChoice: async (workspaces) => {
        assert.equal(workspaces.length, 2);
        return "workspace-2";
      },
    }), 0);
  } finally {
    server.close();
  }
  assert.equal(jsonPrompted, false);
  assert.equal(jsonLogs.stdout.length, 0);
  assert.deepEqual(projectBodies, [{ workspace_id: "workspace-2", name: "Selected" }]);
});

test("human project listing can span workspaces while workspace keys stay scoped", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [
      { id: "project-1", workspace_id: "workspace-1", name: "One", slug: "one" },
      { id: "project-2", workspace_id: "workspace-2", name: "Two", slug: "two" },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  process.env.LOOMUP_PLATFORM_TOKEN = "human-session";
  const humanLogs = output();
  const keyLogs = output();
  const keyCreateLogs = output();
  try {
    assert.equal(await runCli(["projects", "list"], { io: humanLogs.io, platformUrl }), 0);
    process.env.LOOMUP_WORKSPACE_API_KEY = "lbsk_workspace";
    assert.equal(await runCli(["projects", "list"], { io: keyLogs.io, platformUrl }), 2);
    assert.equal(await runCli(["projects", "create", "--name", "Blocked"], {
      io: keyCreateLogs.io, platformUrl,
    }), 2);
  } finally {
    server.close();
  }
  assert.deepEqual(paths, ["/platform/api/projects"]);
  assert.ok(humanLogs.stdout.join("\n").includes("project-1\tworkspace-1\tOne"));
  assert.ok(keyLogs.stderr.join("\n").includes("--workspace is required"));
  assert.ok(keyCreateLogs.stderr.join("\n").includes("--workspace is required"));
});

test("project administration infers canonical linked context and rejects other origins", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { id: "key-1", name: "Deploy", key: "loomup_sk_once", scopes: ["schema:apply"] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-context-"));
  const packagePath = join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({ loomup: { url: platformUrl, project: "project-1" } }));
  process.env.LOOMUP_PLATFORM_TOKEN = "human-session";
  const inferred = output();
  const rejected = output();
  try {
    assert.equal(await runCli(["project-keys", "create", "--name", "Deploy", "--scope", "schema:apply"], {
      cwd: directory, io: inferred.io, platformUrl,
    }), 0);
    await writeFile(packagePath, JSON.stringify({ loomup: { url: "https://self-hosted.example", project: "project-2" } }));
    assert.equal(await runCli(["project-keys", "list"], {
      cwd: directory, io: rejected.io, platformUrl,
    }), 2);
  } finally {
    server.close();
  }
  assert.deepEqual(paths, ["/platform/api/projects/project-1/studio/api-keys"]);
  assert.ok(rejected.stderr.join("\n").includes("linked project uses https://self-hosted.example"));
});

test("create reports recovery when remote creation succeeds but local linking fails", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: {
        project: { id: "project-1", workspace_id: "workspace-1", name: "Remote", slug: "remote" },
        base_url: `${platformUrl}/p/project-1`,
      } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-link-failure-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "failure",
    loomup: { schema: "package.json/schema.yaml" },
  }));
  process.env.LOOMUP_PLATFORM_TOKEN = "human-session";
  const preflightDirectory = await mkdtemp(join(tmpdir(), "loomup-cli-link-preflight-"));
  const preflightLogs = output();
  const logs = output();
  try {
    assert.equal(await runCli([
      "projects", "create", "--workspace", "workspace-1", "--name", "Not Created", "--link",
    ], { cwd: preflightDirectory, io: preflightLogs.io, platformUrl }), 2);
    assert.equal(await runCli([
      "projects", "create", "--workspace", "workspace-1", "--name", "Remote", "--link",
    ], { cwd: directory, io: logs.io, platformUrl }), 1);
  } finally {
    server.close();
  }
  assert.equal(requests, 1);
  assert.ok(preflightLogs.stderr.join("\n").includes("package.json"));
  assert.ok(logs.stdout.join("\n").includes("Created project Remote"));
  assert.ok(logs.stderr.join("\n").includes("was created, but local linking failed"));
  assert.ok(logs.stderr.join("\n").includes(`loomup link --url ${platformUrl}/p/project-1`));
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

test("app-integrity commands use the manager session and send normalized identities", async () => {
  const requests: Array<{ method?: string; path?: string; authorization?: string; body?: any }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url?.endsWith("google-credential")) {
        response.end(JSON.stringify({ data: { configured: true, client_email: "play@example.com" } }));
      } else {
        response.end(JSON.stringify({ data: { policy: { mode: "audit", apps: {} } } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-integrity-"));
  const credentialPath = join(directory, "play.json");
  const privateKey = "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";
  await writeFile(credentialPath, JSON.stringify({
    type: "service_account",
    client_email: "play@example.com",
    private_key: privateKey,
  }));
  process.env.LOOMUP_PLATFORM_TOKEN = "manager-session";
  process.env.LOOMUP_WORKSPACE_API_KEY = "lbsk_must_not_be_used";
  const logs = output();
  try {
    assert.equal(await runCli([
      "app-integrity", "set-ios", "--project", "project-1", "--app-id", "ios_main",
      "--team-id", "TEAM123", "--bundle-id", "com.example.ios", "--apple-app-id", "1234567890",
    ], { io: logs.io, platformUrl }), 0);
    assert.equal(await runCli([
      "app-integrity", "set-android", "--project", "project-1", "--app-id", "android_main",
      "--package-name", "com.example.android", "--cloud-project-number", "123456789012",
      "--certificate-sha256", "01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF",
      "--allow-development",
    ], { io: logs.io, platformUrl }), 0);
    assert.equal(await runCli([
      "app-integrity", "set-mode", "--project", "project-1", "--mode", "audit",
    ], { io: logs.io, platformUrl }), 0);
    assert.equal(await runCli([
      "app-integrity", "put-google-credential", "--project", "project-1", "--file", credentialPath,
    ], { io: logs.io, platformUrl }), 0);
  } finally {
    server.close();
  }
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.authorization === "Bearer manager-session"));
  assert.equal(requests[0]?.path, "/platform/api/projects/project-1/app-integrity/apps/ios_main");
  assert.deepEqual(requests[0]?.body, {
    platform: "ios",
    team_id: "TEAM123",
    bundle_id: "com.example.ios",
    app_apple_id: 1234567890,
    distribution: "app_store_or_testflight",
    allow_development: false,
  });
  assert.deepEqual(requests[1]?.body.signing_certificate_sha256, [
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ]);
  assert.equal(requests[1]?.body.allow_development, true);
  assert.deepEqual(requests[2]?.body, { mode: "audit" });
  assert.equal(requests[3]?.body.credential.private_key, privateKey);
  assert.ok(!logs.stdout.join("\n").includes(privateKey));
});

test("app-integrity status prints native setup without exposing credential secrets", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url?.endsWith("/app-integrity")) {
      response.end(JSON.stringify({ data: { mode: "audit", apps: {
        ios_main: { platform: "ios", bundle_id: "com.example.ios", team_id: "TEAM", app_apple_id: 123 },
        android_main: { platform: "android", package_name: "com.example.android", cloud_project_number: 456 },
      } } }));
    } else if (request.url?.endsWith("google-credential")) {
      response.end(JSON.stringify({ data: { configured: true, client_email: "play@example.com" } }));
    } else {
      response.end(JSON.stringify({ data: { base_url: "https://tryloomup.com/p/project-1" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.LOOMUP_PLATFORM_TOKEN = "manager-session";
  const logs = output();
  try {
    assert.equal(await runCli(
      ["app-integrity", "status", "--project", "project-1"],
      { io: logs.io, platformUrl: `http://127.0.0.1:${address.port}` },
    ), 0);
  } finally {
    server.close();
  }
  const printed = logs.stdout.join("\n");
  assert.match(printed, /Mode: audit/);
  assert.match(printed, /createMobileClient/);
  assert.match(printed, /createAndroidClient/);
  assert.match(printed, /import com\.loomup\.client\.android\.createAndroidClient/);
  assert.match(printed, /play@example.com/);
});

test("app-integrity rejects invalid numeric and certificate flags before transport", async () => {
  process.env.LOOMUP_PLATFORM_TOKEN = "manager-session";
  const badNumber = output();
  assert.equal(await runCli([
    "app-integrity", "set-ios", "--project", "project-1", "--app-id", "ios_main",
    "--team-id", "TEAM", "--bundle-id", "com.example", "--apple-app-id", "not-a-number",
  ], { io: badNumber.io }), 2);
  assert.match(badNumber.stderr.join("\n"), /positive integer/);
  const badCertificate = output();
  assert.equal(await runCli([
    "app-integrity", "set-android", "--project", "project-1", "--app-id", "android_main",
    "--package-name", "com.example", "--cloud-project-number", "123", "--certificate-sha256", "bad",
  ], { io: badCertificate.io }), 2);
  assert.match(badCertificate.stderr.join("\n"), /64-digit/);
});

test("auth and push provider commands use manager APIs without printing secrets", async () => {
  const requests: Array<{ method?: string; path?: string; authorization?: string; body?: any }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.method === "GET") {
        response.end(request.url?.includes("/push/providers")
          ? JSON.stringify({ data: [{
              provider: "expo", configured: false, credential_optional: true,
            }] })
          : JSON.stringify({ data: {
              provider: "google", configured: true, enabled: true,
              client_id: "google-client", callback_url: "https://example.test/oauth/google",
            } }));
      } else if (request.method === "PUT") {
        response.end(JSON.stringify({ data: { credential: { provider: "fcm", configured: true, client_email: "push@example.test" } } }));
      } else {
        response.end(JSON.stringify({ data: { deleted: true } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const platformUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "loomup-cli-providers-"));
  const credentialPath = join(directory, "fcm.json");
  const privateKey = "provider-secret-private-key";
  await writeFile(credentialPath, JSON.stringify({
    type: "service_account",
    project_id: "firebase-project",
    client_email: "push@example.test",
    private_key: privateKey,
  }));
  process.env.LOOMUP_PLATFORM_TOKEN = "manager-session";
  const logs = output();
  try {
    assert.equal(await runCli(
      ["auth-provider", "status", "google", "--project", "project-1"],
      { io: logs.io, platformUrl },
    ), 0);
    assert.equal(await runCli(
      ["push-provider", "status", "--project", "project-1"],
      { io: logs.io, platformUrl },
    ), 0);
    assert.equal(await runCli(
      ["push-provider", "put", "fcm", "--project", "project-1", "--file", credentialPath],
      { io: logs.io, platformUrl },
    ), 0);
    assert.equal(await runCli(
      ["push-provider", "delete", "fcm", "--project", "project-1"],
      { io: logs.io, platformUrl },
    ), 0);
  } finally {
    server.close();
  }
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [
    ["GET", "/platform/api/projects/project-1/auth/providers/google"],
    ["GET", "/platform/api/projects/project-1/push/providers"],
    ["PUT", "/platform/api/projects/project-1/push/providers/fcm"],
    ["DELETE", "/platform/api/projects/project-1/push/providers/fcm"],
  ]);
  assert.ok(requests.every((request) => request.authorization === "Bearer manager-session"));
  assert.equal(requests[2]?.body.credential.private_key, privateKey);
  assert.match(logs.stdout.join("\n"), /expo: ready \(credential optional\)/);
  assert.doesNotMatch(logs.stdout.join("\n"), /provider-secret-private-key/);
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

test("generated clients accept notification projection metadata", () => {
  const source = generateClientSource(`
$notifications:
  table: notifications
  events: []
notifications:
  recipient_id: text
`);
  assert.match(source, /export interface Notifications/);
});

test("generated clients validate portable push declarations", () => {
  const source = generateClientSource(`
$push:
  enabled: true
  tables:
    messages:
      recipient_fields: [recipient_id]
      operations: [insert]
      title: New message
      body: "{{body}}"
messages:
  recipient_id: text
  body: text
`);
  assert.match(source, /export interface Messages/);
  assert.throws(
    () => generateClientSource("$push:\n  tables:\n    missing: {}\nmessages:\n  user_id: text\n"),
    /push table `missing` is not declared/,
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
  memberContent: ["issues"],
  notifications: [{ table: "notifications" }],
  serviceOnly: ["retained_attachments"]
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
notifications:
  workspace_id: workspaces
  project_id: projects
  recipient_id: users
  issue_id: issues
retained_attachments:
  source_attachment_id: text
  r2_key: text
$buckets:
  attachments:
    public: false
`;
  const config = await loadAccessConfig(accessPath);
  const compiled = compileAccess(schema, config);
  assert.deepEqual(Object.keys(compiled.tables).sort(), [
    "issues", "memberships", "notifications", "project_members", "projects", "retained_attachments", "users", "workspaces",
  ]);
  assert.match(compiled.tables.issues!.read, /exists\(memberships/);
  assert.match(compiled.tables.notifications!.read, /row\.recipient_id = auth\.uid\(\)/);
  assert.equal(compiled.tables.notifications!.create, "false");
  assert.equal(compiled.tables.notifications!.notify, compiled.tables.notifications!.read);
  assert.equal(compiled.tables.issues!.subscribe, compiled.tables.issues!.read);
  assert.deepEqual(compiled.tables.retained_attachments, {
    read: "false",
    create: "false",
    update: "false",
    delete: "false",
    subscribe: "false",
    notify: "false",
  });
  assert.match(compiled.tables.issues!.read, /exists\(project_members/);
  assert.equal(compiled.tables.users!.update, "row.id = auth.uid()");
  assert.equal(compiled.tables.users!.delete, "false");
  assert.equal(compiled.buckets.attachments!.read, "(row.owner_id = auth.uid())");
  assert.equal(compiled.buckets.attachments!.delete, "(row.owner_id = auth.uid())");
  assert.ok(!schema.includes("exists("));
});

test("comment child rules use supported ownership checks and direct authorization scope", () => {
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
issue_comments:
  workspace_id: workspaces
  issue_id: issues
  created_by: users
comment_mentions:
  workspace_id: workspaces?
  project_id: projects?
  issue_id: issues?
  comment_id: issue_comments
  user_id: users
comment_attachments:
  workspace_id: workspaces?
  project_id: projects?
  issue_id: issues?
  comment_id: issue_comments
  created_by: users
  related_project_id: projects?
`;
  const compiled = compileAccess(schema, {
    profile: "workspace-project",
    comments: ["issue_comments"],
  });
  const rules = compiled.tables.comment_mentions!;

  assert.match(rules.read, /workspace_id = row\.workspace_id/);
  assert.match(rules.read, /project_id = row\.project_id/);
  assert.doesNotMatch(rules.read, /lookup\(issue_comments/);
  assert.doesNotMatch(rules.read, /lookup\(issues/);
  assert.match(rules.create, /exists\(issue_comments, id = row\.comment_id, created_by = auth\.uid\(\)\)/);
  assert.match(rules.create, /row\.workspace_id = lookup\(issue_comments, workspace_id, id = row\.comment_id\)/);
  assert.match(rules.create, /row\.issue_id = lookup\(issue_comments, issue_id, id = row\.comment_id\)/);
  assert.match(rules.create, /row\.project_id = lookup\(issues, project_id, id = lookup\(issue_comments, issue_id, id = row\.comment_id\)\)/);
  assert.doesNotMatch(rules.create, /lookup\(issue_comments, created_by/);
  assert.equal(rules.update, "false");
  assert.equal(rules.delete, rules.create);

  const attachmentRules = compiled.tables.comment_attachments!;
  assert.doesNotMatch(attachmentRules.read, /lookup\(issue_comments/);
  assert.doesNotMatch(attachmentRules.read, /lookup\(issues/);
  assert.match(attachmentRules.create, /row\.workspace_id = lookup\(issue_comments, workspace_id, id = row\.comment_id\)/);
  assert.match(attachmentRules.create, /row\.project_id = lookup\(issues, project_id, id = lookup\(issue_comments, issue_id, id = row\.comment_id\)\)/);
  assert.match(attachmentRules.create, /row\.issue_id = lookup\(issue_comments, issue_id, id = row\.comment_id\)/);
  assert.doesNotMatch(attachmentRules.create, /row\.related_project_id =/);
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
