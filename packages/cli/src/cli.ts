#!/usr/bin/env node

import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { DEFAULT_CLIENT_PATH, generateClient } from "./generate.js";
import { loadAndCompileAccess } from "./access.js";

type LoomupPackageConfig = {
  url?: string;
  project?: string;
  schema?: string;
  access?: string;
};

type PackageDocument = Record<string, unknown> & {
  loomup?: LoomupPackageConfig;
};

type SchemaAction = {
  kind: string;
  table: string;
  field?: string;
  destructive: boolean;
  summary: string;
};

type SchemaPlan = {
  actions: SchemaAction[];
  blockers: SchemaAction[];
  warnings: string[];
};

type SchemaReport = {
  project_id: string;
  schema_sha256: string;
  revision: number;
  plan: SchemaPlan;
  applied: boolean;
  rollback_snapshot?: { id?: string };
};

type ApiEnvelope<T> = { data: T };

type StoredCredential = {
  platform: typeof PLATFORM_URL;
  token: string;
};

export type CliIO = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

const defaultIO: CliIO = {
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
};

const PLATFORM_URL = "https://tryloomup.com" as const;
const DEFAULT_CREDENTIAL_PATH = join(homedir(), ".loomup", "credentials.json");

type RunOptions = {
  cwd?: string;
  io?: CliIO;
  /** Test-only transport injection. The public CLI always uses PLATFORM_URL. */
  platformUrl?: string;
  /** Test-only credential isolation. */
  credentialPath?: string;
};

const starterSchemaPath = fileURLToPath(
  new URL("../templates/loomup.schema.yaml", import.meta.url),
);
const starterAccessPath = fileURLToPath(
  new URL("../templates/loomup.access.ts", import.meta.url),
);

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) {
    const value = args[exact + 1];
    if (!value || value.startsWith("--")) {
      throw new CliError(`${name} requires a value`, 2);
    }
    return value;
  }
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`${name} requires a value`, 2);
      }
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  return values;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function readStoredCredential(path: string): Promise<string | undefined> {
  try {
    const credential = JSON.parse(await readFile(path, "utf8")) as Partial<StoredCredential>;
    if (credential.platform !== PLATFORM_URL || typeof credential.token !== "string") {
      return undefined;
    }
    return credential.token.trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(`cannot read stored Loomup credentials: ${String(error)}`);
  }
}

async function writeStoredCredential(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ platform: PLATFORM_URL, token } satisfies StoredCredential, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(path, 0o600);
}

async function removeStoredCredential(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function sessionCredential(credentialPath: string): Promise<string> {
  const session = process.env.LOOMUP_PLATFORM_TOKEN?.trim();
  if (session) return session;
  const stored = await readStoredCredential(credentialPath);
  if (stored) return stored;
  throw new CliError("not authenticated; run `loomup auth login`", 2);
}

async function platformCredential(credentialPath: string): Promise<string> {
  const workspaceKey = process.env.LOOMUP_WORKSPACE_API_KEY?.trim();
  return workspaceKey || sessionCredential(credentialPath);
}

function validateOptions(
  args: string[],
  valueOptions: string[],
  booleanOptions: string[],
): void {
  const values = new Set(valueOptions);
  const booleans = new Set(booleanOptions);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      throw new CliError(`unexpected argument: ${argument}`, 2);
    }
    const name = argument.split("=", 1)[0]!;
    if (booleans.has(name)) {
      if (argument.includes("=")) {
        throw new CliError(`${name} does not take a value`, 2);
      }
      continue;
    }
    if (!values.has(name)) {
      throw new CliError(
        name === "--token"
          ? "credentials are accepted only through LOOMUP_API_KEY or LOOMUP_PLATFORM_TOKEN"
          : `unknown option: ${name}`,
        2,
      );
    }
    if (!argument.includes("=")) index += 1;
  }
}

async function findPackageJson(start: string): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readPackage(path: string): Promise<PackageDocument> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PackageDocument;
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${String(error)}`, 2);
  }
}

async function ensureStarterSchema(path: string, io: CliIO): Promise<boolean> {
  const starter = await readFile(starterSchemaPath, "utf8").catch((error) => {
    throw new CliError(`cannot read packaged starter schema: ${String(error)}`);
  });
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, starter, { encoding: "utf8", flag: "wx" });
    io.stdout(`Created starter schema at ${path}.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new CliError(`cannot create starter schema ${path}: ${String(error)}`);
  }
}

async function ensureStarterAccess(path: string, io: CliIO): Promise<boolean> {
  const starter = await readFile(starterAccessPath, "utf8").catch((error) => {
    throw new CliError(`cannot read packaged starter access config: ${String(error)}`);
  });
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, starter, { encoding: "utf8", flag: "wx" });
    io.stdout(`Created starter access config at ${path}.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new CliError(`cannot create starter access config ${path}: ${String(error)}`);
  }
}

async function initProject(args: string[], cwd: string, io: CliIO): Promise<number> {
  validateOptions(args, ["--schema", "--access"], []);
  const packagePath = await findPackageJson(cwd);
  if (!packagePath) {
    throw new CliError("init must run inside a project with package.json", 2);
  }
  const document = await readPackage(packagePath);
  const schema =
    option(args, "--schema") ?? document.loomup?.schema ?? "loomup.schema.yaml";
  const schemaPath = resolve(dirname(packagePath), schema);
  const access = option(args, "--access") ?? document.loomup?.access ?? "loomup.access.ts";
  const accessPath = resolve(dirname(packagePath), access);
  const created = await ensureStarterSchema(schemaPath, io);
  const accessCreated = await ensureStarterAccess(accessPath, io);
  document.loomup = { ...(document.loomup ?? {}), schema, access };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (!created) io.stdout(`Schema already exists at ${schemaPath}; left it unchanged.`);
  if (!accessCreated) io.stdout(`Access config already exists at ${accessPath}; left it unchanged.`);
  const generated = await generateClient({
    schemaPath,
    projectRoot: dirname(packagePath),
    platformUrl: document.loomup.url,
    projectId: document.loomup.project,
  });
  io.stdout(`Generated Loomup client at ${generated.outputPath}.`);
  return 0;
}

function parseLoomupUrl(value: string): { url: string; project?: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError(`invalid Loomup URL: ${value}`, 2);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CliError("Loomup URL must use http or https", 2);
  }
  const gateway = /^\/p(?:\/([^/]+))?\/?$/.exec(parsed.pathname);
  if (gateway) {
    return {
      url: parsed.origin,
      project: gateway[1] ? decodeURIComponent(gateway[1]) : undefined,
    };
  }
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString().replace(/\/$/, "") };
}

function cleanUrl(value: string): string {
  return parseLoomupUrl(value).url;
}

type ResolvedProject = {
  url: string;
  project: string;
  schemaPath: string;
  accessPath?: string;
  packagePath?: string;
};

async function resolveProject(args: string[], cwd: string): Promise<ResolvedProject> {
  const packagePath = await findPackageJson(cwd);
  const packageDocument = packagePath ? await readPackage(packagePath) : undefined;
  const config = packageDocument?.loomup ?? {};
  const urlValue = option(args, "--url") ?? process.env.LOOMUP_URL ?? config.url;
  const parsedUrl = urlValue ? parseLoomupUrl(urlValue) : undefined;
  const project =
    option(args, "--project") ??
    process.env.LOOMUP_PROJECT_ID ??
    config.project ??
    parsedUrl?.project;
  const schema =
    option(args, "--schema") ?? process.env.LOOMUP_SCHEMA ?? config.schema ?? "loomup.schema.yaml";
  const access = option(args, "--access") ?? process.env.LOOMUP_ACCESS ?? config.access;
  if (!parsedUrl || !project) {
    throw new CliError(
      "project is not linked; run `loomup link --url <platform-url> --project <project-id>`",
      2,
    );
  }
  const root = packagePath ? dirname(packagePath) : cwd;
  return {
    url: parsedUrl.url,
    project,
    schemaPath: resolve(root, schema),
    accessPath: access ? resolve(root, access) : undefined,
    packagePath,
  };
}

async function loomupCredential(
  credentialPath: string,
): Promise<{ token: string; projectKey: boolean }> {
  const projectKey = process.env.LOOMUP_API_KEY?.trim();
  if (projectKey) return { token: projectKey, projectKey: true };
  const token =
    process.env.LOOMUP_PLATFORM_TOKEN?.trim() ?? (await readStoredCredential(credentialPath));
  if (!token) {
    throw new CliError(
      "LOOMUP_API_KEY is required (with schema permission); LOOMUP_PLATFORM_TOKEN also works for interactive use",
      2,
    );
  }
  return { token, projectKey: token.startsWith("loomup_sk_") };
}

async function requestJson<T>(
  url: string,
  token: string | undefined,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new CliError(`cannot reach Loomup: ${String(error)}`);
  }
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? text ?? response.statusText;
    const code = response.status === 400 || response.status === 422 ? 2 : 1;
    throw new CliError(`Loomup ${response.status}: ${String(message)}`, code);
  }
  return body as T;
}

function printPlan(report: SchemaReport, io: CliIO): void {
  if (!report.plan.actions.length && !report.plan.blockers.length) {
    io.stdout(`Schema is current (${report.schema_sha256.slice(0, 12)}).`);
    return;
  }
  for (const action of report.plan.actions) {
    io.stdout(`${action.destructive ? "!" : "+"} ${action.summary}`);
  }
  for (const blocker of report.plan.blockers) {
    io.stdout(`x ${blocker.summary}`);
  }
  for (const warning of report.plan.warnings) {
    io.stdout(`? ${warning}`);
  }
}

async function migrate(
  args: string[],
  cwd: string,
  io: CliIO,
  credentialPath: string,
): Promise<number> {
  validateOptions(
    args,
    ["--url", "--project", "--schema", "--access"],
    ["--plan", "--allow-data-loss", "--json"],
  );
  const project = await resolveProject(args, cwd);
  const { token } = await loomupCredential(credentialPath);
  let schema: string;
  try {
    schema = await readFile(project.schemaPath, "utf8");
  } catch (error) {
    throw new CliError(`cannot read schema ${project.schemaPath}: ${String(error)}`, 2);
  }
  const compiledAccess = await loadAndCompileAccess(schema, project.accessPath).catch((error) => {
    throw new CliError(String(error), 2);
  });
  const endpoint = `${project.url}/platform/api/projects/${encodeURIComponent(project.project)}/schema/${compiledAccess ? "migrate-with-access" : "migrate"}`;
  const planned = await requestJson<ApiEnvelope<SchemaReport>>(endpoint, token, {
    method: "POST",
    body: JSON.stringify({ schema, compiled_access: compiledAccess, dry_run: true, allow_data_loss: false }),
  });
  const jsonOutput = flag(args, "--json");
  if (flag(args, "--plan")) {
    if (jsonOutput) io.stdout(JSON.stringify(planned.data, null, 2));
    else printPlan(planned.data, io);
    return planned.data.plan.blockers.length ? 2 : 0;
  }
  if (planned.data.plan.blockers.length) {
    if (jsonOutput) io.stdout(JSON.stringify(planned.data, null, 2));
    else printPlan(planned.data, io);
    return 2;
  }
  const destructive = planned.data.plan.actions.some((action) => action.destructive);
  const allowDataLoss = flag(args, "--allow-data-loss");
  if (destructive && !allowDataLoss) {
    if (jsonOutput) io.stdout(JSON.stringify(planned.data, null, 2));
    else {
      printPlan(planned.data, io);
      io.stderr("Destructive changes were not applied. Rerun with --allow-data-loss after review.");
    }
    return 2;
  }
  const applied = await requestJson<ApiEnvelope<SchemaReport>>(endpoint, token, {
    method: "POST",
    body: JSON.stringify({
      schema,
      compiled_access: compiledAccess,
      dry_run: false,
      allow_data_loss: allowDataLoss,
    }),
  });
  const generated = await generateClient({
    schemaPath: project.schemaPath,
    projectRoot: project.packagePath ? dirname(project.packagePath) : cwd,
    platformUrl: project.url,
    projectId: project.project,
  });
  if (jsonOutput) {
    io.stdout(JSON.stringify(applied.data, null, 2));
  } else if (!applied.data.applied) {
    io.stdout(`Schema is current (${applied.data.schema_sha256.slice(0, 12)}).`);
  } else {
    printPlan(applied.data, io);
    io.stdout(`Applied schema revision ${applied.data.revision}.`);
    if (applied.data.rollback_snapshot?.id) {
      io.stdout(`Rollback snapshot: ${applied.data.rollback_snapshot.id}`);
    }
  }
  if (!jsonOutput) io.stdout(`Generated Loomup client at ${generated.outputPath}.`);
  return 0;
}

async function linkProject(
  args: string[],
  cwd: string,
  io: CliIO,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--url", "--project", "--schema", "--access"], []);
  const urlValue = option(args, "--url") ?? process.env.LOOMUP_URL;
  const parsedUrl = urlValue ? parseLoomupUrl(urlValue) : undefined;
  const project =
    option(args, "--project") ?? process.env.LOOMUP_PROJECT_ID ?? parsedUrl?.project;
  if (!parsedUrl || !project) {
    throw new CliError(
      "link requires --url and --project (or a /p/<project-id> URL)",
      2,
    );
  }
  const url = parsedUrl.url;
  const packagePath = await findPackageJson(cwd);
  if (!packagePath) {
    throw new CliError("link must run inside a project with package.json", 2);
  }
  const document = await readPackage(packagePath);
  const schema =
    option(args, "--schema") ?? document.loomup?.schema ?? "loomup.schema.yaml";
  const schemaPath = resolve(dirname(packagePath), schema);
  const access = option(args, "--access") ?? document.loomup?.access ?? "loomup.access.ts";
  const accessPath = resolve(dirname(packagePath), access);
  await ensureStarterSchema(schemaPath, io);
  await ensureStarterAccess(accessPath, io);
  const credential = await loomupCredential(credentialPath);
  if (credential.projectKey) {
    const schemaSource = await readFile(schemaPath, "utf8");
    const compiledAccess = await loadAndCompileAccess(schemaSource, accessPath).catch((error) => {
      throw new CliError(String(error), 2);
    });
    await requestJson(
      `${url}/platform/api/projects/${encodeURIComponent(project)}/schema/${compiledAccess ? "migrate-with-access" : "migrate"}`,
      credential.token,
      {
        method: "POST",
        body: JSON.stringify({ schema: schemaSource, compiled_access: compiledAccess, dry_run: true, allow_data_loss: false }),
      },
    );
  } else {
    await requestJson(
      `${url}/platform/api/projects/${encodeURIComponent(project)}`,
      credential.token,
    );
  }
  document.loomup = {
    ...(document.loomup ?? {}),
    url,
    project,
    schema,
    access,
  };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const generated = await generateClient({
    schemaPath,
    projectRoot: dirname(packagePath),
    platformUrl: url,
    projectId: project,
  });
  io.stdout(`Linked ${basename(dirname(packagePath))} to Loomup project ${project}.`);
  io.stdout(`Generated Loomup client at ${generated.outputPath}.`);
  return 0;
}

async function generateProjectClient(
  args: string[],
  cwd: string,
  io: CliIO,
): Promise<number> {
  validateOptions(args, ["--schema", "--output"], []);
  const packagePath = await findPackageJson(cwd);
  if (!packagePath) {
    throw new CliError("generate must run inside a project with package.json", 2);
  }
  const document = await readPackage(packagePath);
  const schema = option(args, "--schema") ?? document.loomup?.schema ?? "loomup.schema.yaml";
  const projectRoot = dirname(packagePath);
  const urlValue = process.env.LOOMUP_URL ?? document.loomup?.url;
  const parsedUrl = urlValue ? parseLoomupUrl(urlValue) : undefined;
  const projectId =
    process.env.LOOMUP_PROJECT_ID ?? document.loomup?.project ?? parsedUrl?.project;
  const generated = await generateClient({
    schemaPath: resolve(projectRoot, schema),
    projectRoot,
    platformUrl: parsedUrl?.url,
    projectId,
    outputPath: option(args, "--output") ?? DEFAULT_CLIENT_PATH,
  });
  io.stdout(`Generated Loomup client at ${generated.outputPath}.`);
  return 0;
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new CliError("interactive token login requires a TTY", 2);
  }
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      const text = String(chunk);
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          process.stderr.write("\n");
          return value;
        }
        if (character === "\u0003") throw new CliError("cancelled", 1);
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return value;
}

async function login(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, [], []);
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const email = await readline.question("Platform email: ");
  readline.close();
  const password = await promptHidden("Platform password: ");
  let response: Response;
  try {
    response = await fetch(`${platformUrl}/platform/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    throw new CliError(`cannot reach Loomup: ${String(error)}`);
  }
  if (!response.ok) {
    throw new CliError(`login failed (${response.status})`);
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  const token = /(?:^|[,;]\s*)loomup_platform_session=([^;,]+)/.exec(setCookie)?.[1];
  if (!token) throw new CliError("login response did not contain a platform session");
  await writeStoredCredential(credentialPath, decodeURIComponent(token));
  io.stdout(`Authenticated with ${PLATFORM_URL}.`);
  return 0;
}

async function authStatus(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, [], []);
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<{ email: string }>>(
    `${platformUrl}/platform/api/auth/me`,
    token,
  );
  io.stdout(`Authenticated as ${response.data.email} on ${PLATFORM_URL}.`);
  return 0;
}

async function logout(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, [], []);
  const token = await readStoredCredential(credentialPath);
  if (token) {
    await requestJson(`${platformUrl}/platform/api/auth/logout`, token, {
      method: "POST",
      body: "{}",
    }).catch(() => undefined);
  }
  await removeStoredCredential(credentialPath);
  io.stdout(`Signed out from ${PLATFORM_URL}.`);
  return 0;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name)?.trim();
  if (!value) throw new CliError(`${name} is required`, 2);
  return value;
}

function optionalExpiry(args: string[]): number | undefined {
  const value = option(args, "--expires-at");
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CliError("--expires-at must be a Unix timestamp or ISO date", 2);
  }
  return Math.floor(timestamp / 1000);
}

async function createHostedProject(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--workspace", "--name", "--template"], ["--json"]);
  const workspace = requiredOption(args, "--workspace");
  const name = requiredOption(args, "--name");
  const token = await platformCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<any>>(
    `${platformUrl}/platform/api/projects`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspace,
        name,
        ...(option(args, "--template") ? { template: option(args, "--template") } : {}),
      }),
    },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else {
    io.stdout(`Created project ${response.data.project.name} (${response.data.project.id}).`);
    if (response.data.base_url) io.stdout(`Project URL: ${response.data.base_url}`);
  }
  return 0;
}

async function listHostedProjects(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--workspace"], ["--json"]);
  const workspace = requiredOption(args, "--workspace");
  const token = await platformCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<any[]>>(
    `${platformUrl}/platform/api/projects?workspace_id=${encodeURIComponent(workspace)}`,
    token,
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else for (const project of response.data) io.stdout(`${project.id}\t${project.name}`);
  return 0;
}

async function createProjectKey(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(
    args,
    ["--project", "--name", "--scope", "--expires-at"],
    ["--json"],
  );
  const project = requiredOption(args, "--project");
  const name = requiredOption(args, "--name");
  const scopes = options(args, "--scope").map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.length) throw new CliError("at least one --scope is required", 2);
  const token = await platformCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<any>>(
    `${platformUrl}/platform/api/projects/${encodeURIComponent(project)}/studio/api-keys`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ name, scopes, expires_at: optionalExpiry(args) }),
    },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else {
    io.stdout("Project API key created. Copy it now; it will not be shown again:");
    io.stdout(response.data.key);
  }
  return 0;
}

async function listProjectKeys(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project"], ["--json"]);
  const project = requiredOption(args, "--project");
  const token = await platformCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<any[]>>(
    `${platformUrl}/platform/api/projects/${encodeURIComponent(project)}/studio/api-keys`,
    token,
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else {
    for (const key of response.data) {
      io.stdout(`${key.id}\t${key.name}\t${(key.scopes ?? []).join(",")}`);
    }
  }
  return 0;
}

async function revokeProjectKey(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project", "--id"], []);
  const project = requiredOption(args, "--project");
  const id = requiredOption(args, "--id");
  const token = await platformCredential(credentialPath);
  await requestJson(
    `${platformUrl}/platform/api/projects/${encodeURIComponent(project)}/studio/api-keys/${encodeURIComponent(id)}`,
    token,
    { method: "DELETE" },
  );
  io.stdout(`Revoked project API key ${id}.`);
  return 0;
}

function usage(io: CliIO): void {
  io.stdout(`Usage:
  loomup auth login
  loomup auth status
  loomup auth logout
  loomup projects create --workspace <id> --name <name> [--template <name>] [--json]
  loomup projects list --workspace <id> [--json]
  loomup project-keys create --project <id> --name <name> --scope <scope>... [--json]
  loomup project-keys list --project <id> [--json]
  loomup project-keys revoke --project <id> --id <key-id>
  loomup init [--schema <path>] [--access <path>]
  loomup generate [--schema <path>] [--output <path>]
  loomup migrate [--plan] [--allow-data-loss] [--json] [--schema <path>] [--access <path>]
  loomup link --url <project-url> --project <project-id> [--schema <path>] [--access <path>]

Platform authentication and provisioning always use ${PLATFORM_URL}.`);
}

export async function runCli(
  args = process.argv.slice(2),
  options: RunOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIO;
  const cwd = options.cwd ?? process.cwd();
  const platformUrl = options.platformUrl ?? PLATFORM_URL;
  const credentialPath = options.credentialPath ?? DEFAULT_CREDENTIAL_PATH;
  try {
    if (!args.length || flag(args, "--help") || flag(args, "-h")) {
      usage(io);
      return 0;
    }
    if (args[0] === "init") return await initProject(args.slice(1), cwd, io);
    if (args[0] === "generate") {
      return await generateProjectClient(args.slice(1), cwd, io);
    }
    if (args[0] === "migrate")
      return await migrate(args.slice(1), cwd, io, credentialPath);
    if (args[0] === "link")
      return await linkProject(args.slice(1), cwd, io, credentialPath);
    if (args[0] === "auth" && args[1] === "login")
      return await login(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "auth" && args[1] === "status")
      return await authStatus(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "auth" && args[1] === "logout")
      return await logout(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "projects" && args[1] === "create")
      return await createHostedProject(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "projects" && args[1] === "list")
      return await listHostedProjects(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "project-keys" && args[1] === "create")
      return await createProjectKey(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "project-keys" && args[1] === "list")
      return await listProjectKeys(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "project-keys" && args[1] === "revoke")
      return await revokeProjectKey(args.slice(2), io, platformUrl, credentialPath);
    throw new CliError(`unknown command: ${args.join(" ")}`, 2);
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError(String(error));
    io.stderr(cliError.message);
    return cliError.exitCode;
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    // npm/bun expose package binaries through symlinks in node_modules/.bin.
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  process.exitCode = await runCli();
}
