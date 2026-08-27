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
  output?: string;
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

type DataListMeta = {
  limit: number;
  offset: number;
  total: number;
  truncated?: boolean;
  next_cursor?: string;
};

type DataListResponse = {
  data: Record<string, unknown>[];
  meta: DataListMeta;
};

type DataAccess = {
  kind: "manager" | "project_key";
  token: string;
};

type DataResourceInfo = {
  name: string;
  fields: number;
  source: "managed" | "discovered";
};

type ProjectOperation = {
  id: string;
  project_id: string;
  kind: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  result?: SchemaReport;
  error_code?: string;
  error_message?: string;
};

type AppIntegrityMode = "off" | "audit" | "enforce";

type AppIntegrityApp = {
  platform: "ios" | "android";
  team_id?: string;
  bundle_id?: string;
  app_apple_id?: number;
  distribution?: "app_store_or_testflight";
  package_name?: string;
  cloud_project_number?: number;
  signing_certificate_sha256?: string[];
  allow_development?: boolean;
};

type AppIntegrityPolicy = {
  mode: AppIntegrityMode;
  apps: Record<string, AppIntegrityApp>;
};

type AppIntegrityCredentialStatus = {
  configured: boolean;
  client_email?: string;
  google_project_id?: string;
  updated_at?: number;
};

type ProviderCredentialStatus = {
  provider: string;
  configured: boolean;
  credential_optional?: boolean;
  enabled?: boolean;
  callback_url?: string;
  client_id?: string;
  project_id?: string;
  client_email?: string;
  team_id?: string;
  key_id?: string;
  topic?: string;
  subject?: string;
  production?: boolean;
  public_key?: string;
  updated_at?: number;
};

type ApiEnvelope<T> = { data: T };

type Workspace = {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string;
  created_at: number;
};

type HostedProject = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
};

type HostedProjectDetail = {
  project: HostedProject;
  base_url?: string;
  studio_url?: string;
};

type ProjectApiKey = {
  id: string;
  name: string;
  scopes?: string[];
};

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
  /** Test-only interactive-mode override. */
  interactive?: boolean;
  /** Test-only login prompt injection. */
  loginCredentials?: () => Promise<{ email: string; password: string }>;
  /** Test-only workspace selector injection. */
  workspaceChoice?: (workspaces: Workspace[]) => Promise<string>;
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
  validateOptions(args, ["--schema", "--access", "--output"], []);
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
  const output = option(args, "--output") ?? document.loomup?.output ?? DEFAULT_CLIENT_PATH;
  const created = await ensureStarterSchema(schemaPath, io);
  const accessCreated = await ensureStarterAccess(accessPath, io);
  document.loomup = { ...(document.loomup ?? {}), schema, access, output };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (!created) io.stdout(`Schema already exists at ${schemaPath}; left it unchanged.`);
  if (!accessCreated) io.stdout(`Access config already exists at ${accessPath}; left it unchanged.`);
  const generated = await generateClient({
    schemaPath,
    projectRoot: dirname(packagePath),
    platformUrl: document.loomup.url,
    projectId: document.loomup.project,
    outputPath: output,
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

async function resolveHostedProjectId(
  args: string[],
  cwd: string,
  platformUrl: string,
): Promise<string> {
  const explicit = option(args, "--project")?.trim();
  if (explicit) return explicit;
  const environment = process.env.LOOMUP_PROJECT_ID?.trim();
  if (environment) return environment;
  const packagePath = await findPackageJson(cwd);
  if (packagePath) {
    const config = (await readPackage(packagePath)).loomup;
    if (config?.project && config.url) {
      if (cleanUrl(config.url) === cleanUrl(platformUrl)) return config.project;
      throw new CliError(
        `linked project uses ${cleanUrl(config.url)}; pass --project for hosted commands on ${cleanUrl(platformUrl)}`,
        2,
      );
    }
  }
  throw new CliError(
    `--project is required unless LOOMUP_PROJECT_ID is set or the package is linked to ${cleanUrl(platformUrl)}`,
    2,
  );
}

type ResolvedProject = {
  url: string;
  project: string;
  schemaPath: string;
  accessPath?: string;
  packagePath?: string;
  outputPath: string;
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
    outputPath: config.output ?? DEFAULT_CLIENT_PATH,
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
  const timeout = AbortSignal.timeout(30_000);
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ?? timeout,
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProjectOperation(value: unknown): value is ProjectOperation {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as ProjectOperation).id === "string" &&
      typeof (value as ProjectOperation).state === "string" &&
      typeof (value as ProjectOperation).stage === "string",
  );
}

async function waitForProjectOperation(
  platformUrl: string,
  projectId: string,
  operation: ProjectOperation,
  token: string,
  io: CliIO,
  jsonOutput: boolean,
): Promise<SchemaReport> {
  const endpoint = `${platformUrl}/platform/api/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operation.id)}`;
  const deadline = Date.now() + 150_000;
  let current = operation;
  let reportedStage = "";
  while (current.state === "queued" || current.state === "running") {
    if (!jsonOutput && current.stage !== reportedStage) {
      io.stderr(`Schema operation ${current.stage}…`);
      reportedStage = current.stage;
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        `schema operation ${current.id} did not finish within 150 seconds; inspect it at ${endpoint}`,
      );
    }
    await delay(500);
    const response = await requestJson<ApiEnvelope<ProjectOperation>>(endpoint, token);
    current = response.data;
  }
  if (current.state === "succeeded" && current.result) return current.result;
  if (current.state === "cancelled") {
    throw new CliError(`schema operation ${current.id} was cancelled`);
  }
  throw new CliError(
    `schema operation ${current.id} failed${current.error_code ? ` (${current.error_code})` : ""}: ${current.error_message ?? "unknown error"}`,
  );
}

async function fetchWorkspaces(platformUrl: string, token: string): Promise<Workspace[]> {
  const response = await requestJson<ApiEnvelope<Workspace[]>>(
    `${platformUrl}/platform/api/workspaces`,
    token,
  );
  return response.data;
}

function printWorkspaces(workspaces: Workspace[], io: CliIO): void {
  if (!workspaces.length) {
    io.stdout("No workspaces found. Create one with `loomup workspaces create --name <name>`.");
    return;
  }
  for (const workspace of workspaces) {
    io.stdout(`${workspace.id}\t${workspace.name}\t${workspace.slug}`);
  }
}

function workspaceChoices(workspaces: Workspace[]): string {
  return workspaces.map((workspace) => `  ${workspace.id}\t${workspace.name}`).join("\n");
}

async function promptForWorkspace(workspaces: Workspace[]): Promise<string> {
  process.stderr.write("Choose a workspace:\n");
  workspaces.forEach((workspace, index) => {
    process.stderr.write(`  ${index + 1}) ${workspace.name} (${workspace.id})\n`);
  });
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = (await readline.question("Workspace: ")).trim();
      const number = Number(answer);
      if (Number.isInteger(number) && number >= 1 && number <= workspaces.length) {
        return workspaces[number - 1]!.id;
      }
      const exact = workspaces.find((workspace) => workspace.id === answer);
      if (exact) return exact.id;
      process.stderr.write(`Enter a number from 1 to ${workspaces.length} or an exact workspace ID.\n`);
    }
  } finally {
    readline.close();
  }
}

async function resolveWorkspaceForCreate(
  args: string[],
  platformUrl: string,
  credentialPath: string,
  interactive: boolean,
  workspaceChoice?: (workspaces: Workspace[]) => Promise<string>,
): Promise<{ workspace: string; token: string }> {
  const explicit = option(args, "--workspace")?.trim();
  if (explicit) return { workspace: explicit, token: await platformCredential(credentialPath) };
  if (process.env.LOOMUP_WORKSPACE_API_KEY?.trim()) {
    throw new CliError("--workspace is required when using LOOMUP_WORKSPACE_API_KEY", 2);
  }
  const token = await sessionCredential(credentialPath);
  const workspaces = await fetchWorkspaces(platformUrl, token);
  if (!workspaces.length) {
    throw new CliError(
      "no workspace available; create one with `loomup workspaces create --name <name>`",
      2,
    );
  }
  if (workspaces.length === 1) return { workspace: workspaces[0]!.id, token };
  if (flag(args, "--json") || (!interactive && !workspaceChoice)) {
    throw new CliError(
      `multiple workspaces available; rerun with --workspace <id>:\n${workspaceChoices(workspaces)}`,
      2,
    );
  }
  const selected = await (workspaceChoice ?? promptForWorkspace)(workspaces);
  if (!workspaces.some((workspace) => workspace.id === selected)) {
    throw new CliError(`unknown workspace selection ${JSON.stringify(selected)}`, 2);
  }
  return { workspace: selected, token };
}

function printPlan(report: SchemaReport, io: CliIO): void {
  if (!report.plan.actions.length && !report.plan.blockers.length && !report.plan.warnings.length) {
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
  const submitted = await requestJson<ApiEnvelope<SchemaReport | ProjectOperation>>(endpoint, token, {
    method: "POST",
    headers: { Prefer: "respond-async" },
    body: JSON.stringify({
      schema,
      compiled_access: compiledAccess,
      dry_run: false,
      allow_data_loss: allowDataLoss,
    }),
  });
  const applied = isProjectOperation(submitted.data)
    ? await waitForProjectOperation(
        project.url,
        project.project,
        submitted.data,
        token,
        io,
        jsonOutput,
      )
    : submitted.data;
  const generated = await generateClient({
    schemaPath: project.schemaPath,
    projectRoot: project.packagePath ? dirname(project.packagePath) : cwd,
    platformUrl: project.url,
    projectId: project.project,
    outputPath: project.outputPath,
  });
  if (jsonOutput) {
    io.stdout(JSON.stringify(applied, null, 2));
  } else if (!applied.applied) {
    io.stdout(`Schema is current (${applied.schema_sha256.slice(0, 12)}).`);
  } else {
    printPlan(applied, io);
    io.stdout(`Applied schema revision ${applied.revision}.`);
    if (applied.rollback_snapshot?.id) {
      io.stdout(`Rollback snapshot: ${applied.rollback_snapshot.id}`);
    }
  }
  if (!jsonOutput) io.stdout(`Generated Loomup client at ${generated.outputPath}.`);
  return 0;
}

type LinkTarget = {
  packagePath: string;
  schema: string;
  schemaPath: string;
  access: string;
  accessPath: string;
  output: string;
};

type LocalLinkResult = {
  package_path: string;
  output_path: string;
};

async function prepareLinkTarget(args: string[], cwd: string): Promise<LinkTarget> {
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
  const output = option(args, "--output") ?? document.loomup?.output ?? DEFAULT_CLIENT_PATH;
  return { packagePath, schema, schemaPath, access, accessPath, output };
}

async function persistProjectLink(
  target: LinkTarget,
  url: string,
  project: string,
  io: CliIO,
): Promise<LocalLinkResult> {
  const { packagePath, schema, schemaPath, access, accessPath, output } = target;
  await ensureStarterSchema(schemaPath, io);
  await ensureStarterAccess(accessPath, io);
  const document = await readPackage(packagePath);
  document.loomup = {
    ...(document.loomup ?? {}),
    url,
    project,
    schema,
    access,
    output,
  };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const generated = await generateClient({
    schemaPath,
    projectRoot: dirname(packagePath),
    platformUrl: url,
    projectId: project,
    outputPath: output,
  });
  io.stdout(`Linked ${basename(dirname(packagePath))} to Loomup project ${project}.`);
  io.stdout(`Generated Loomup client at ${generated.outputPath}.`);
  return { package_path: packagePath, output_path: generated.outputPath };
}

async function linkProject(
  args: string[],
  cwd: string,
  io: CliIO,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--url", "--project", "--schema", "--access", "--output"], []);
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
  const target = await prepareLinkTarget(args, cwd);
  await ensureStarterSchema(target.schemaPath, io);
  await ensureStarterAccess(target.accessPath, io);
  const credential = await loomupCredential(credentialPath);
  if (credential.projectKey) {
    const schemaSource = await readFile(target.schemaPath, "utf8");
    const compiledAccess = await loadAndCompileAccess(schemaSource, target.accessPath).catch((error) => {
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
  await persistProjectLink(target, url, project, io);
  return 0;
}

function requiredArgument(args: string[], index: number, label: string): string {
  const value = args[index]?.trim();
  if (!value || value.startsWith("--")) {
    throw new CliError(`${label} is required`, 2);
  }
  return value;
}

function validateResourceName(resource: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(resource) || resource.startsWith("_")) {
    throw new CliError(
      "resource must start with a letter and contain only letters, numbers, and underscores",
      2,
    );
  }
}

function assignment(value: string, optionName: string): { name: string; value: string } {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new CliError(`${optionName} must use <field>=<value>`, 2);
  }
  return { name: value.slice(0, separator), value: value.slice(separator + 1) };
}

function nonNegativeIntegerOption(args: string[], name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new CliError(`${name} must be a non-negative integer`, 2);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`${name} must be a non-negative safe integer`, 2);
  }
  return value;
}

const dataFilterOperators: Record<string, string> = {
  eq: "eq",
  ne: "ne",
  lt: "lt",
  lte: "lte",
  gt: "gt",
  gte: "gte",
  in: "in",
  isNull: "is_null",
  is_null: "is_null",
  contains: "contains",
  startsWith: "starts_with",
  starts_with: "starts_with",
};

function appendDataFilters(params: URLSearchParams, args: string[]): void {
  for (const raw of options(args, "--where")) {
    const item = assignment(raw, "--where");
    const value = item.value === "true" ? "1" : item.value === "false" ? "0" : item.value;
    params.set(`where[${item.name}]`, value);
  }
  for (const raw of options(args, "--filter")) {
    const item = assignment(raw, "--filter");
    const separator = item.name.lastIndexOf(".");
    if (separator <= 0 || separator === item.name.length - 1) {
      throw new CliError(
        "--filter must use <field>.<operator>=<value>",
        2,
      );
    }
    const field = item.name.slice(0, separator);
    const requestedOperator = item.name.slice(separator + 1);
    const operator = dataFilterOperators[requestedOperator];
    if (!operator) {
      throw new CliError(
        `unknown filter operator ${JSON.stringify(requestedOperator)}; use eq, ne, lt, lte, gt, gte, in, isNull, contains, or startsWith`,
        2,
      );
    }
    params.set(`filter[${field}][${operator}]`, item.value);
  }
}

async function resolveDataProject(
  args: string[],
  cwd: string,
  platformUrl: string,
): Promise<ResolvedProject> {
  const packagePath = await findPackageJson(cwd);
  const packageDocument = packagePath ? await readPackage(packagePath) : undefined;
  const config = packageDocument?.loomup ?? {};
  const urlValue = option(args, "--url") ?? process.env.LOOMUP_URL ?? config.url;
  const parsedUrl = urlValue ? parseLoomupUrl(urlValue) : parseLoomupUrl(platformUrl);
  const project =
    option(args, "--project") ??
    process.env.LOOMUP_PROJECT_ID ??
    config.project ??
    parsedUrl.project;
  if (!project) {
    throw new CliError(
      "project is required; run inside a linked package or pass --project <project-id>",
      2,
    );
  }
  const root = packagePath ? dirname(packagePath) : cwd;
  const schema = process.env.LOOMUP_SCHEMA ?? config.schema ?? "loomup.schema.yaml";
  return {
    url: parsedUrl.url,
    project,
    schemaPath: resolve(root, schema),
    accessPath: undefined,
    packagePath,
    outputPath: config.output ?? DEFAULT_CLIENT_PATH,
  };
}

async function resolveDataAccess(
  project: ResolvedProject,
  platformUrl: string,
  credentialPath: string,
  forceProjectKey: boolean,
): Promise<DataAccess> {
  const legacyToken = process.env.LOOMUP_PLATFORM_TOKEN?.trim();
  const projectKey =
    process.env.LOOMUP_API_KEY?.trim() ||
    (legacyToken?.startsWith("loomup_sk_") ? legacyToken : undefined);
  if (forceProjectKey) {
    if (projectKey) return { kind: "project_key", token: projectKey };
    throw new CliError(
      "--use-project-key requires LOOMUP_API_KEY with resource:<name>:read or project:backend permission",
      2,
    );
  }
  if (cleanUrl(project.url) === cleanUrl(platformUrl)) {
    const managerToken =
      legacyToken && !legacyToken.startsWith("loomup_sk_")
        ? legacyToken
        : await readStoredCredential(credentialPath);
    if (managerToken) return { kind: "manager", token: managerToken };
  }
  if (projectKey) return { kind: "project_key", token: projectKey };
  throw new CliError(
    "not authenticated; run `loomup auth login` or set LOOMUP_API_KEY with Resource read permission",
    2,
  );
}

function projectGatewayUrl(project: ResolvedProject): string {
  return `${project.url.replace(/\/$/, "")}/p/${encodeURIComponent(project.project)}`;
}

function dataCollectionUrl(
  project: ResolvedProject,
  access: DataAccess,
  resource: string,
): string {
  if (access.kind === "project_key") {
    return `${projectGatewayUrl(project)}/api/${encodeURIComponent(resource)}`;
  }
  return `${project.url}/platform/api/projects/${encodeURIComponent(project.project)}/studio/resources/${encodeURIComponent(resource)}/records`;
}

async function fetchDataPage(
  project: ResolvedProject,
  access: DataAccess,
  resource: string,
  params: URLSearchParams,
): Promise<DataListResponse> {
  const query = params.toString();
  return requestJson<DataListResponse>(
    `${dataCollectionUrl(project, access, resource)}${query ? `?${query}` : ""}`,
    access.token,
  );
}

function dataValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncateCell(value: string, width = 36): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function printTable(rows: Record<string, unknown>[], io: CliIO): void {
  if (!rows.length) {
    io.stdout("No records found.");
    return;
  }
  const allColumns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const columns = allColumns.slice(0, 8);
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...rows.map((row) => truncateCell(dataValue(row[column])).length),
    ),
  );
  io.stdout(columns.map((column, index) => column.padEnd(widths[index]!)).join("  "));
  io.stdout(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    io.stdout(
      columns
        .map((column, index) => truncateCell(dataValue(row[column])).padEnd(widths[index]!))
        .join("  "),
    );
  }
  if (allColumns.length > columns.length) {
    io.stderr(
      `Showing ${columns.length} of ${allColumns.length} fields; use --select, --json, or --jsonl for the rest.`,
    );
  }
}

function printDataList(resource: string, result: DataListResponse, io: CliIO): void {
  printTable(result.data, io);
  io.stdout(
    `Showing ${result.data.length} of ${result.meta.total} record(s) (offset ${result.meta.offset}).`,
  );
  if (result.meta.truncated) {
    io.stderr("The total is a lower bound because the server scan limit was reached.");
  }
  if (result.meta.next_cursor) {
    io.stdout(`Next: loomup data list ${resource} --cursor ${result.meta.next_cursor}`);
  }
}

function validateDataOutput(args: string[]): void {
  if (flag(args, "--json") && flag(args, "--jsonl")) {
    throw new CliError("--json and --jsonl cannot be combined", 2);
  }
}

async function fetchAllData(
  project: ResolvedProject,
  access: DataAccess,
  resource: string,
  baseParams: URLSearchParams,
): Promise<DataListResponse> {
  const first = await fetchDataPage(project, access, resource, baseParams);
  const data = [...first.data];
  let current = first;
  let truncated = Boolean(first.meta.truncated);
  while (true) {
    let nextParams: URLSearchParams | undefined;
    if (access.kind === "project_key" && current.meta.next_cursor) {
      nextParams = new URLSearchParams({ cursor: current.meta.next_cursor });
    } else if (access.kind === "manager") {
      const nextOffset = current.meta.offset + current.data.length;
      if (!current.data.length || nextOffset >= current.meta.total) break;
      nextParams = new URLSearchParams(baseParams);
      nextParams.set("offset", String(nextOffset));
    }
    if (!nextParams) break;
    current = await fetchDataPage(project, access, resource, nextParams);
    data.push(...current.data);
    truncated ||= Boolean(current.meta.truncated);
  }
  return {
    data,
    meta: {
      ...first.meta,
      total: current.meta.total,
      truncated: truncated || undefined,
      next_cursor: undefined,
    },
  };
}

async function listProjectData(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  const resource = requiredArgument(args, 0, "resource");
  validateResourceName(resource);
  const commandArgs = args.slice(1);
  validateOptions(
    commandArgs,
    ["--url", "--project", "--where", "--filter", "--select", "--sort", "--limit", "--offset", "--cursor"],
    ["--all", "--json", "--jsonl", "--use-project-key"],
  );
  validateDataOutput(commandArgs);
  const cursor = option(commandArgs, "--cursor");
  if (
    cursor &&
    ["--where", "--filter", "--select", "--sort", "--limit", "--offset"].some((name) =>
      commandArgs.some((argument) => argument === name || argument.startsWith(`${name}=`)),
    )
  ) {
    throw new CliError(
      "--cursor cannot be combined with filters, sort, select, limit, or offset",
      2,
    );
  }
  const project = await resolveDataProject(commandArgs, cwd, platformUrl);
  const access = await resolveDataAccess(
    project,
    platformUrl,
    credentialPath,
    flag(commandArgs, "--use-project-key") || Boolean(cursor),
  );
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  else {
    appendDataFilters(params, commandArgs);
    const selected = options(commandArgs, "--select").flatMap((value) => value.split(","));
    if (selected.length) params.set("select", selected.join(","));
    const sort = option(commandArgs, "--sort");
    if (sort) params.set("sort", sort);
    const limit = nonNegativeIntegerOption(commandArgs, "--limit");
    const offset = nonNegativeIntegerOption(commandArgs, "--offset");
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
  }
  const response = flag(commandArgs, "--all")
    ? await fetchAllData(project, access, resource, params)
    : await fetchDataPage(project, access, resource, params);
  if (flag(commandArgs, "--json")) io.stdout(JSON.stringify(response, null, 2));
  else if (flag(commandArgs, "--jsonl")) {
    for (const record of response.data) io.stdout(JSON.stringify(record));
  } else printDataList(resource, response, io);
  return 0;
}

async function countProjectData(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  const resource = requiredArgument(args, 0, "resource");
  validateResourceName(resource);
  const commandArgs = args.slice(1);
  validateOptions(
    commandArgs,
    ["--url", "--project", "--where", "--filter"],
    ["--json", "--use-project-key"],
  );
  const project = await resolveDataProject(commandArgs, cwd, platformUrl);
  const access = await resolveDataAccess(
    project,
    platformUrl,
    credentialPath,
    flag(commandArgs, "--use-project-key"),
  );
  const params = new URLSearchParams({ limit: "1" });
  appendDataFilters(params, commandArgs);
  const response = await fetchDataPage(project, access, resource, params);
  if (flag(commandArgs, "--json")) io.stdout(JSON.stringify(response.meta, null, 2));
  else io.stdout(String(response.meta.total));
  if (response.meta.truncated) {
    io.stderr("The count is a lower bound because the server scan limit was reached.");
  }
  return 0;
}

async function getProjectData(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  const resource = requiredArgument(args, 0, "resource");
  const id = requiredArgument(args, 1, "record id");
  validateResourceName(resource);
  const commandArgs = args.slice(2);
  validateOptions(
    commandArgs,
    ["--url", "--project"],
    ["--json", "--jsonl", "--use-project-key"],
  );
  validateDataOutput(commandArgs);
  const project = await resolveDataProject(commandArgs, cwd, platformUrl);
  const access = await resolveDataAccess(
    project,
    platformUrl,
    credentialPath,
    flag(commandArgs, "--use-project-key"),
  );
  const response = await requestJson<{ data: Record<string, unknown> }>(
    `${dataCollectionUrl(project, access, resource)}/${encodeURIComponent(id)}`,
    access.token,
  );
  if (flag(commandArgs, "--json")) io.stdout(JSON.stringify(response, null, 2));
  else if (flag(commandArgs, "--jsonl")) io.stdout(JSON.stringify(response.data));
  else io.stdout(JSON.stringify(response.data, null, 2));
  return 0;
}

async function discoverProjectResources(
  project: ResolvedProject,
  access: DataAccess,
): Promise<DataResourceInfo[]> {
  if (access.kind !== "manager") {
    throw new CliError(
      "resource discovery requires `loomup auth login`; project keys can still use data list, count, and get",
      2,
    );
  }
  const response = await requestJson<ApiEnvelope<{
    manifest?: { resources?: Record<string, { fields?: Record<string, unknown> }> };
    discovered_resources?: Array<{ name: string; columns?: unknown[] }>;
    archived_resources?: string[];
  }>>(
    `${project.url}/platform/api/projects/${encodeURIComponent(project.project)}/studio/schema`,
    access.token,
  );
  const managed = response.data.manifest?.resources ?? {};
  const discovered = new Map(
    (response.data.discovered_resources ?? []).map((resource) => [resource.name, resource]),
  );
  const archived = new Set(response.data.archived_resources ?? []);
  const names = new Set([...Object.keys(managed), ...discovered.keys()]);
  return [...names]
    .filter((name) => !archived.has(name))
    .sort()
    .map((name) => ({
      name,
      fields: managed[name]?.fields
        ? Object.keys(managed[name]!.fields!).length
        : discovered.get(name)?.columns?.length ?? 0,
      source: Object.prototype.hasOwnProperty.call(managed, name) ? "managed" : "discovered",
    }));
}

async function listProjectResources(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--url", "--project"], ["--json", "--jsonl"]);
  validateDataOutput(args);
  const project = await resolveDataProject(args, cwd, platformUrl);
  const access = await resolveDataAccess(project, platformUrl, credentialPath, false);
  const resources = await discoverProjectResources(project, access);
  if (flag(args, "--json")) io.stdout(JSON.stringify(resources, null, 2));
  else if (flag(args, "--jsonl")) {
    for (const resource of resources) io.stdout(JSON.stringify(resource));
  } else printTable(resources.map((resource) => ({ ...resource })), io);
  return 0;
}

async function summarizeProjectData(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--url", "--project"], ["--json"]);
  const project = await resolveDataProject(args, cwd, platformUrl);
  const access = await resolveDataAccess(project, platformUrl, credentialPath, false);
  const resources = await discoverProjectResources(project, access);
  const summary: Array<Record<string, unknown>> = [];
  for (const resource of resources) {
    const result = await fetchDataPage(
      project,
      access,
      resource.name,
      new URLSearchParams({ limit: "1" }),
    );
    summary.push({
      resource: resource.name,
      records: result.meta.total,
      fields: resource.fields,
      source: resource.source,
      count: result.meta.truncated ? "lower bound" : "exact",
    });
  }
  if (flag(args, "--json")) {
    io.stdout(JSON.stringify({ project: project.project, resources: summary }, null, 2));
  } else {
    io.stdout(`Project ${project.project}`);
    printTable(summary, io);
  }
  return 0;
}

async function generateProjectClient(
  args: string[],
  cwd: string,
  io: CliIO,
): Promise<number> {
  validateOptions(args, ["--schema", "--output"], ["--check"]);
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
    outputPath: option(args, "--output") ?? document.loomup?.output ?? DEFAULT_CLIENT_PATH,
    check: flag(args, "--check"),
  });
  io.stdout(`${flag(args, "--check") ? "Verified" : "Generated"} Loomup client at ${generated.outputPath}.`);
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

async function promptLoginCredentials(): Promise<{ email: string; password: string }> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const email = await readline.question("Platform email: ");
  readline.close();
  const password = await promptHidden("Platform password: ");
  return { email, password };
}

async function login(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
  loginCredentials: () => Promise<{ email: string; password: string }> = promptLoginCredentials,
): Promise<number> {
  validateOptions(args, [], []);
  const { email, password } = await loginCredentials();
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
  const decodedToken = decodeURIComponent(token);
  await writeStoredCredential(credentialPath, decodedToken);
  io.stdout(`Authenticated with ${PLATFORM_URL}.`);
  try {
    const workspaces = await fetchWorkspaces(platformUrl, decodedToken);
    printWorkspaces(workspaces, io);
  } catch (error) {
    io.stderr(`Authenticated, but workspace discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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

async function listHostedWorkspaces(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, [], ["--json"]);
  const token = await sessionCredential(credentialPath);
  const workspaces = await fetchWorkspaces(platformUrl, token);
  if (flag(args, "--json")) io.stdout(JSON.stringify(workspaces, null, 2));
  else printWorkspaces(workspaces, io);
  return 0;
}

async function createHostedWorkspace(
  args: string[],
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--name"], ["--json"]);
  const name = requiredOption(args, "--name");
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<Workspace>>(
    `${platformUrl}/platform/api/workspaces`,
    token,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Created workspace ${response.data.name} (${response.data.id}).`);
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
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
  interactive: boolean,
  workspaceChoice?: (workspaces: Workspace[]) => Promise<string>,
): Promise<number> {
  validateOptions(args, ["--workspace", "--name", "--template"], ["--json", "--link"]);
  const name = requiredOption(args, "--name");
  const linkTarget = flag(args, "--link") ? await prepareLinkTarget(args, cwd) : undefined;
  const { workspace, token } = await resolveWorkspaceForCreate(
    args,
    platformUrl,
    credentialPath,
    interactive,
    workspaceChoice,
  );
  const response = await requestJson<ApiEnvelope<HostedProjectDetail>>(
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
  const project = response.data.project;
  const baseUrl = response.data.base_url?.replace(/\/$/, "") || `${platformUrl}/p/${encodeURIComponent(project.id)}`;
  const recoveryCommand = `loomup link --url ${baseUrl}`;
  const jsonOutput = flag(args, "--json");
  if (!jsonOutput) {
    io.stdout(`Created project ${response.data.project.name} (${response.data.project.id}).`);
    io.stdout(`Project URL: ${baseUrl}`);
  }
  let localLink: LocalLinkResult | undefined;
  if (linkTarget) {
    const linkIo = jsonOutput ? { stdout: () => undefined, stderr: () => undefined } : io;
    try {
      localLink = await persistProjectLink(linkTarget, cleanUrl(baseUrl), project.id, linkIo);
    } catch (error) {
      throw new CliError(
        `project ${project.name} (${project.id}) was created, but local linking failed: ${error instanceof Error ? error.message : String(error)}\nRecover with: ${recoveryCommand}`,
      );
    }
  }
  if (jsonOutput) {
    io.stdout(JSON.stringify(localLink ? { ...response.data, local_link: localLink } : response.data, null, 2));
  } else if (!linkTarget) {
    io.stdout(`Next: ${recoveryCommand}`);
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
  const workspace = option(args, "--workspace")?.trim();
  if (!workspace && process.env.LOOMUP_WORKSPACE_API_KEY?.trim()) {
    throw new CliError("--workspace is required when using LOOMUP_WORKSPACE_API_KEY", 2);
  }
  const token = workspace
    ? await platformCredential(credentialPath)
    : await sessionCredential(credentialPath);
  const endpoint = workspace
    ? `${platformUrl}/platform/api/projects?workspace_id=${encodeURIComponent(workspace)}`
    : `${platformUrl}/platform/api/projects`;
  const response = await requestJson<ApiEnvelope<HostedProject[]>>(
    endpoint,
    token,
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else if (!response.data.length) io.stdout("No projects found.");
  else for (const project of response.data) {
    io.stdout(workspace
      ? `${project.id}\t${project.name}`
      : `${project.id}\t${project.workspace_id}\t${project.name}`);
  }
  return 0;
}

async function createProjectKey(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(
    args,
    ["--project", "--name", "--scope", "--expires-at"],
    ["--json"],
  );
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const name = requiredOption(args, "--name");
  const scopes = options(args, "--scope").map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.length) throw new CliError("at least one --scope is required", 2);
  const token = await platformCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<ProjectApiKey & { key: string }>>(
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
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project"], ["--json"]);
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const token = await platformCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<ProjectApiKey[]>>(
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
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project", "--id"], []);
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
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

function positiveSafeInteger(args: string[], name: string): number {
  const raw = requiredOption(args, name);
  if (!/^\d+$/.test(raw)) throw new CliError(`${name} must be a positive integer`, 2);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError(`${name} must be a positive safe integer`, 2);
  }
  return value;
}

function appIntegrityAppId(args: string[]): string {
  const appId = requiredOption(args, "--app-id");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(appId) || appId.length > 128) {
    throw new CliError("--app-id must be at most 128 characters, start with a letter or underscore, and contain only letters, numbers, and underscores", 2);
  }
  return appId;
}

function normalizeCertificate(value: string): string {
  const normalized = value.trim().replaceAll(":", "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new CliError("--certificate-sha256 must be a 64-digit SHA-256 hex digest", 2);
  }
  return normalized;
}

function appIntegrityEndpoint(platformUrl: string, project: string, suffix = ""): string {
  return `${platformUrl}/platform/api/projects/${encodeURIComponent(project)}/app-integrity${suffix}`;
}

function swiftMobileSnippet(baseUrl: string, appId: string): string {
  return `import Loomup\nimport LoomupAppIntegrity\n\nlet loomup = createMobileClient(\n    url: URL(string: ${JSON.stringify(baseUrl)})!,\n    appID: ${JSON.stringify(appId)}\n)`;
}

function androidMobileSnippet(
  baseUrl: string,
  appId: string,
  cloudProjectNumber: number,
): string {
  return `import com.loomup.client.android.createAndroidClient\n\nval loomup = createAndroidClient(\n    context = applicationContext,\n    url = ${JSON.stringify(baseUrl)},\n    appId = ${JSON.stringify(appId)},\n    cloudProjectNumber = ${cloudProjectNumber}L,\n)`;
}

async function appIntegrityStatus(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project"], ["--json"]);
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const token = await sessionCredential(credentialPath);
  const [policy, credential, detail] = await Promise.all([
    requestJson<ApiEnvelope<AppIntegrityPolicy>>(appIntegrityEndpoint(platformUrl, project), token),
    requestJson<ApiEnvelope<AppIntegrityCredentialStatus>>(
      appIntegrityEndpoint(platformUrl, project, "/google-credential"),
      token,
    ),
    requestJson<ApiEnvelope<{ base_url?: string }>>(
      `${platformUrl}/platform/api/projects/${encodeURIComponent(project)}`,
      token,
    ),
  ]);
  const baseUrl = String(detail.data.base_url ?? "").replace(/\/$/, "");
  if (flag(args, "--json")) {
    io.stdout(JSON.stringify({ policy: policy.data, google_credential: credential.data, base_url: baseUrl }, null, 2));
    return 0;
  }
  io.stdout(`Mode: ${policy.data.mode}`);
  const entries = Object.entries(policy.data.apps ?? {});
  if (!entries.length) io.stdout("Apps: none");
  for (const [appId, app] of entries) {
    if (app.platform === "ios") {
      io.stdout(`\niOS ${appId}\n  bundle: ${app.bundle_id}\n  team: ${app.team_id}\n  Apple app ID: ${app.app_apple_id}`);
      if (baseUrl) io.stdout(`\n${swiftMobileSnippet(baseUrl, appId)}`);
    } else {
      io.stdout(`\nAndroid ${appId}\n  package: ${app.package_name}\n  cloud project: ${app.cloud_project_number}`);
      if (baseUrl && app.cloud_project_number) {
        io.stdout(`\n${androidMobileSnippet(baseUrl, appId, app.cloud_project_number)}`);
      }
    }
    if (app.allow_development) io.stdout("  warning: development proofs are allowed");
  }
  io.stdout(`\nGoogle Play credential: ${credential.data.configured ? "configured" : "not configured"}`);
  if (credential.data.client_email) io.stdout(`  client: ${credential.data.client_email}`);
  if (credential.data.google_project_id) io.stdout(`  project: ${credential.data.google_project_id}`);
  return 0;
}

async function setIosAppIntegrity(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(
    args,
    ["--project", "--app-id", "--team-id", "--bundle-id", "--apple-app-id"],
    ["--allow-development", "--json"],
  );
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const appId = appIntegrityAppId(args);
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<{ policy: AppIntegrityPolicy }>>(
    appIntegrityEndpoint(platformUrl, project, `/apps/${encodeURIComponent(appId)}`),
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        platform: "ios",
        team_id: requiredOption(args, "--team-id"),
        bundle_id: requiredOption(args, "--bundle-id"),
        app_apple_id: positiveSafeInteger(args, "--apple-app-id"),
        distribution: "app_store_or_testflight",
        allow_development: flag(args, "--allow-development"),
      }),
    },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Configured iOS app ${appId} for project ${project}.`);
  return 0;
}

async function setAndroidAppIntegrity(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(
    args,
    ["--project", "--app-id", "--package-name", "--cloud-project-number", "--certificate-sha256"],
    ["--allow-development", "--json"],
  );
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const appId = appIntegrityAppId(args);
  const certificates = options(args, "--certificate-sha256").map(normalizeCertificate);
  if (!certificates.length) throw new CliError("at least one --certificate-sha256 is required", 2);
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<{ policy: AppIntegrityPolicy }>>(
    appIntegrityEndpoint(platformUrl, project, `/apps/${encodeURIComponent(appId)}`),
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        platform: "android",
        package_name: requiredOption(args, "--package-name"),
        cloud_project_number: positiveSafeInteger(args, "--cloud-project-number"),
        signing_certificate_sha256: certificates,
        allow_development: flag(args, "--allow-development"),
      }),
    },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Configured Android app ${appId} for project ${project}.`);
  return 0;
}

async function removeAppIntegrityApp(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project", "--app-id"], ["--json"]);
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const appId = appIntegrityAppId(args);
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<{ policy: AppIntegrityPolicy }>>(
    appIntegrityEndpoint(platformUrl, project, `/apps/${encodeURIComponent(appId)}`),
    token,
    { method: "DELETE" },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Removed app ${appId} from project ${project}.`);
  return 0;
}

async function setAppIntegrityMode(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project", "--mode"], ["--json"]);
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const mode = requiredOption(args, "--mode") as AppIntegrityMode;
  if (!["off", "audit", "enforce"].includes(mode)) {
    throw new CliError("--mode must be off, audit, or enforce", 2);
  }
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<{ policy: AppIntegrityPolicy }>>(
    appIntegrityEndpoint(platformUrl, project, "/mode"),
    token,
    { method: "PUT", body: JSON.stringify({ mode }) },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Set app integrity mode to ${mode} for project ${project}.`);
  return 0;
}

async function putGoogleIntegrityCredential(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project", "--file"], ["--json"]);
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const path = resolve(requiredOption(args, "--file"));
  let credential: unknown;
  try {
    credential = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`cannot read Google credential JSON: ${String(error)}`, 2);
  }
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new CliError("Google credential must be a JSON object", 2);
  }
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<AppIntegrityCredentialStatus>>(
    appIntegrityEndpoint(platformUrl, project, "/google-credential"),
    token,
    { method: "PUT", body: JSON.stringify({ credential }) },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Google Play credential configured for ${response.data.client_email ?? project}.`);
  return 0;
}

async function deleteGoogleIntegrityCredential(
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  validateOptions(args, ["--project"], ["--json"]);
  const project = await resolveHostedProjectId(args, cwd, platformUrl);
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<{ ok: boolean }>>(
    appIntegrityEndpoint(platformUrl, project, "/google-credential"),
    token,
    { method: "DELETE" },
  );
  if (flag(args, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Deleted Google Play credential for project ${project}.`);
  return 0;
}

type ProviderFamily = "auth" | "push";

function providerNames(family: ProviderFamily): string[] {
  return family === "auth"
    ? ["google", "apple", "github"]
    : ["expo", "fcm", "apns", "webpush"];
}

function providerEndpoint(
  platformUrl: string,
  project: string,
  family: ProviderFamily,
  provider?: string,
): string {
  const suffix = provider ? `/${encodeURIComponent(provider)}` : "";
  return `${platformUrl}/platform/api/projects/${encodeURIComponent(project)}/${family}/providers${suffix}`;
}

function providerArgument(args: string[], family: ProviderFamily, required: boolean): { provider?: string; options: string[] } {
  const provider = args[0] && !args[0].startsWith("--") ? args[0].toLowerCase() : undefined;
  if (required && !provider) throw new CliError("provider is required", 2);
  if (provider && !providerNames(family).includes(provider)) {
    throw new CliError(`provider must be one of: ${providerNames(family).join(", ")}`, 2);
  }
  return { provider, options: provider ? args.slice(1) : args };
}

async function providerStatus(
  family: ProviderFamily,
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  const parsed = providerArgument(args, family, false);
  validateOptions(parsed.options, ["--project"], ["--json"]);
  const project = await resolveHostedProjectId(parsed.options, cwd, platformUrl);
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<ProviderCredentialStatus | ProviderCredentialStatus[]>>(
    providerEndpoint(platformUrl, project, family, parsed.provider),
    token,
  );
  if (flag(parsed.options, "--json")) {
    io.stdout(JSON.stringify(response.data, null, 2));
    return 0;
  }
  const statuses = Array.isArray(response.data) ? response.data : [response.data];
  for (const status of statuses) {
    const enabled = family === "auth" ? `, ${status.enabled ? "enabled" : "disabled"}` : "";
    const configuration = status.configured
      ? "configured"
      : status.credential_optional
        ? "ready (credential optional)"
        : "not configured";
    io.stdout(`${status.provider}: ${configuration}${enabled}`);
    if (status.callback_url) io.stdout(`  callback: ${status.callback_url}`);
    if (status.client_id) io.stdout(`  client: ${status.client_id}`);
    if (status.client_email) io.stdout(`  service account: ${status.client_email}`);
    if (status.project_id) io.stdout(`  project: ${status.project_id}`);
    if (status.topic) io.stdout(`  topic: ${status.topic}`);
    if (status.subject) io.stdout(`  subject: ${status.subject}`);
    if (status.public_key) io.stdout(`  public key: ${status.public_key}`);
  }
  return 0;
}

async function putProviderCredential(
  family: ProviderFamily,
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  const parsed = providerArgument(args, family, true);
  validateOptions(parsed.options, ["--project", "--file"], ["--json"]);
  const project = await resolveHostedProjectId(parsed.options, cwd, platformUrl);
  const file = resolve(requiredOption(parsed.options, "--file"));
  let credential: unknown;
  try {
    credential = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new CliError(`cannot read provider credential JSON: ${String(error)}`, 2);
  }
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new CliError("provider credential must be a JSON object", 2);
  }
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<ProviderCredentialStatus | { credential: ProviderCredentialStatus }>>(
    providerEndpoint(platformUrl, project, family, parsed.provider),
    token,
    { method: "PUT", body: JSON.stringify({ credential }) },
  );
  const status = "credential" in response.data ? response.data.credential : response.data;
  if (flag(parsed.options, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Configured ${family} provider ${status.provider} for project ${project}.`);
  return 0;
}

async function deleteProviderCredential(
  family: ProviderFamily,
  args: string[],
  cwd: string,
  io: CliIO,
  platformUrl: string,
  credentialPath: string,
): Promise<number> {
  const parsed = providerArgument(args, family, true);
  validateOptions(parsed.options, ["--project"], ["--json"]);
  const project = await resolveHostedProjectId(parsed.options, cwd, platformUrl);
  const token = await sessionCredential(credentialPath);
  const response = await requestJson<ApiEnvelope<unknown>>(
    providerEndpoint(platformUrl, project, family, parsed.provider),
    token,
    { method: "DELETE" },
  );
  if (flag(parsed.options, "--json")) io.stdout(JSON.stringify(response.data, null, 2));
  else io.stdout(`Deleted ${family} provider ${parsed.provider} for project ${project}.`);
  return 0;
}

function usage(io: CliIO): void {
  io.stdout(`Usage:
  loomup auth login
  loomup auth status
  loomup auth logout
  loomup workspaces list [--json]
  loomup workspaces create --name <name> [--json]
  loomup projects create --name <name> [--workspace <id>] [--template <name>] [--link] [--json]
  loomup projects list [--workspace <id>] [--json]
  loomup data resources [--project <id>] [--url <url>] [--json|--jsonl]
  loomup data summary [--project <id>] [--url <url>] [--json]
  loomup data list <resource> [--where <field>=<value>]... [--filter <field>.<operator>=<value>]... [--select <fields>] [--sort <spec>] [--limit <n>] [--offset <n>] [--cursor <token>] [--all] [--project <id>] [--url <url>] [--json|--jsonl] [--use-project-key]
  loomup data count <resource> [--where <field>=<value>]... [--filter <field>.<operator>=<value>]... [--project <id>] [--url <url>] [--json] [--use-project-key]
  loomup data get <resource> <record-id> [--project <id>] [--url <url>] [--json|--jsonl] [--use-project-key]
  loomup project-keys create [--project <id>] --name <name> --scope <scope>... [--json]
  loomup project-keys list [--project <id>] [--json]
  loomup project-keys revoke [--project <id>] --id <key-id>
  loomup app-integrity status [--project <id>] [--json]
  loomup app-integrity set-ios [--project <id>] --app-id <id> --team-id <id> --bundle-id <id> --apple-app-id <number> [--allow-development] [--json]
  loomup app-integrity set-android [--project <id>] --app-id <id> --package-name <name> --cloud-project-number <number> --certificate-sha256 <digest>... [--allow-development] [--json]
  loomup app-integrity remove-app [--project <id>] --app-id <id> [--json]
  loomup app-integrity set-mode [--project <id>] --mode <off|audit|enforce> [--json]
  loomup app-integrity put-google-credential [--project <id>] --file <json> [--json]
  loomup app-integrity delete-google-credential [--project <id>] [--json]
  loomup auth-provider status [provider] [--project <id>] [--json]
  loomup auth-provider put <google|apple|github> --file <json> [--project <id>] [--json]
  loomup auth-provider delete <google|apple|github> [--project <id>] [--json]
  loomup push-provider status [provider] [--project <id>] [--json]
  loomup push-provider put <expo|fcm|apns|webpush> --file <json> [--project <id>] [--json]
  loomup push-provider delete <expo|fcm|apns|webpush> [--project <id>] [--json]
  loomup init [--schema <path>] [--access <path>] [--output <path>]
  loomup generate [--schema <path>] [--output <path>] [--check]
  loomup migrate [--plan] [--allow-data-loss] [--json] [--schema <path>] [--access <path>]
  loomup link --url <project-url> --project <project-id> [--schema <path>] [--access <path>] [--output <path>]

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
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
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
      return await login(args.slice(2), io, platformUrl, credentialPath, options.loginCredentials);
    if (args[0] === "auth" && args[1] === "status")
      return await authStatus(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "auth" && args[1] === "logout")
      return await logout(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "workspaces" && args[1] === "list")
      return await listHostedWorkspaces(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "workspaces" && args[1] === "create")
      return await createHostedWorkspace(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "projects" && args[1] === "create")
      return await createHostedProject(
        args.slice(2), cwd, io, platformUrl, credentialPath, interactive, options.workspaceChoice,
      );
    if (args[0] === "projects" && args[1] === "list")
      return await listHostedProjects(args.slice(2), io, platformUrl, credentialPath);
    if (args[0] === "data" && args[1] === "resources")
      return await listProjectResources(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "data" && args[1] === "summary")
      return await summarizeProjectData(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "data" && args[1] === "list")
      return await listProjectData(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "data" && args[1] === "count")
      return await countProjectData(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "data" && args[1] === "get")
      return await getProjectData(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "project-keys" && args[1] === "create")
      return await createProjectKey(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "project-keys" && args[1] === "list")
      return await listProjectKeys(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "project-keys" && args[1] === "revoke")
      return await revokeProjectKey(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "app-integrity" && args[1] === "status")
      return await appIntegrityStatus(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "app-integrity" && args[1] === "set-ios")
      return await setIosAppIntegrity(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "app-integrity" && args[1] === "set-android")
      return await setAndroidAppIntegrity(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "app-integrity" && args[1] === "remove-app")
      return await removeAppIntegrityApp(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "app-integrity" && args[1] === "set-mode")
      return await setAppIntegrityMode(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "app-integrity" && args[1] === "put-google-credential")
      return await putGoogleIntegrityCredential(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "app-integrity" && args[1] === "delete-google-credential")
      return await deleteGoogleIntegrityCredential(args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "auth-provider" && args[1] === "status")
      return await providerStatus("auth", args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "auth-provider" && args[1] === "put")
      return await putProviderCredential("auth", args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "auth-provider" && args[1] === "delete")
      return await deleteProviderCredential("auth", args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "push-provider" && args[1] === "status")
      return await providerStatus("push", args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "push-provider" && args[1] === "put")
      return await putProviderCredential("push", args.slice(2), cwd, io, platformUrl, credentialPath);
    if (args[0] === "push-provider" && args[1] === "delete")
      return await deleteProviderCredential("push", args.slice(2), cwd, io, platformUrl, credentialPath);
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
