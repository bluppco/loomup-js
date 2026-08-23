import { readFile } from "node:fs/promises";
import ts from "typescript";
import { parse } from "yaml";

type AccessOperations = {
  read: string;
  create: string;
  update: string;
  delete: string;
  subscribe: string;
  notify: string;
};

export type CompiledAccess = {
  tables: Record<string, AccessOperations>;
  buckets: Record<string, AccessOperations>;
};

type PublishedContent = {
  table: string;
  statusField?: string;
  publishedValue?: string;
  audienceField?: string | null;
  departments?: string;
  departmentContentField?: string;
};

type WorkspaceProjectConfig = {
  profile: "workspace-project";
  tables?: {
    users?: string;
    workspaces?: string;
    memberships?: string;
    projects?: string;
    projectMembers?: string;
    departments?: string;
    projectDepartments?: string;
    invitations?: string;
  };
  publicWorkspaces?: boolean;
  publishedContent?: PublishedContent[];
  memberContent?: string[];
  comments?: string[];
  ownedUploads?: string[];
  objects?: Array<{ table: string; pathField?: string }>;
};

type AccessConfig = { profile: "authenticated" } | WorkspaceProjectConfig;
type SchemaTable = { fields: Map<string, string | undefined> };
type SchemaShape = { tables: Map<string, SchemaTable>; buckets: string[] };

const primitiveTypes = new Set([
  "id",
  "text",
  "integer",
  "real",
  "boolean",
  "datetime",
  "json",
]);

function fail(message: string): never {
  throw new Error(`invalid Loomup access config: ${message}`);
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${context} must be a non-empty string`);
  return value.trim();
}

function strings(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value.map((entry, index) => string(entry, `${context}[${index}]`));
}

function parseSchema(source: string): SchemaShape {
  const root = object(parse(source), "schema");
  const tables = new Map<string, SchemaTable>();
  for (const [tableName, rawTable] of Object.entries(root)) {
    if (tableName.startsWith("$")) continue;
    const table = object(rawTable, `schema table ${tableName}`);
    const fields = new Map<string, string | undefined>();
    for (const [fieldName, rawField] of Object.entries(table)) {
      if (fieldName.startsWith("$")) continue;
      let token: unknown = rawField;
      if (rawField && typeof rawField === "object" && !Array.isArray(rawField)) {
        const definition = rawField as Record<string, unknown>;
        token = definition.type ?? (Array.isArray(definition.enum) ? "text" : undefined);
      }
      if (typeof token !== "string") continue;
      const normalized = token.replace(/\?$/, "");
      fields.set(fieldName, primitiveTypes.has(normalized) ? undefined : normalized);
    }
    if (!fields.has("id")) fields.set("id", undefined);
    tables.set(tableName, { fields });
  }
  const rawBuckets = root.$buckets;
  const buckets = rawBuckets && typeof rawBuckets === "object" && !Array.isArray(rawBuckets)
    ? Object.keys(rawBuckets as Record<string, unknown>)
    : [];
  return { tables, buckets };
}

function validateConfig(value: unknown): AccessConfig {
  const config = object(value, "default export");
  const profile = string(config.profile, "profile");
  if (profile === "authenticated") return { profile };
  if (profile !== "workspace-project") fail(`unknown profile ${JSON.stringify(profile)}`);
  const tables = config.tables === undefined ? {} : object(config.tables, "tables");
  const optional = (name: string) => tables[name] === undefined ? undefined : required(name);
  const required = (name: string) => string(tables[name], `tables.${name}`);
  const publishedContent = config.publishedContent === undefined
    ? []
    : (Array.isArray(config.publishedContent) ? config.publishedContent : fail("publishedContent must be an array"))
      .map((raw, index) => {
        const item = object(raw, `publishedContent[${index}]`);
        return {
          table: string(item.table, `publishedContent[${index}].table`),
          statusField: item.statusField === undefined ? undefined : string(item.statusField, `publishedContent[${index}].statusField`),
          publishedValue: item.publishedValue === undefined ? undefined : string(item.publishedValue, `publishedContent[${index}].publishedValue`),
          audienceField: item.audienceField === null ? null : item.audienceField === undefined ? undefined : string(item.audienceField, `publishedContent[${index}].audienceField`),
          departments: item.departments === undefined ? undefined : string(item.departments, `publishedContent[${index}].departments`),
          departmentContentField: item.departmentContentField === undefined ? undefined : string(item.departmentContentField, `publishedContent[${index}].departmentContentField`),
        };
      });
  const objects = config.objects === undefined
    ? []
    : (Array.isArray(config.objects) ? config.objects : fail("objects must be an array"))
      .map((raw, index) => {
        const item = object(raw, `objects[${index}]`);
        return {
          table: string(item.table, `objects[${index}].table`),
          pathField: item.pathField === undefined ? undefined : string(item.pathField, `objects[${index}].pathField`),
        };
      });
  return {
    profile,
    tables: {
      users: optional("users"),
      workspaces: optional("workspaces"),
      memberships: optional("memberships"),
      projects: optional("projects"),
      projectMembers: optional("projectMembers"),
      departments: optional("departments"),
      projectDepartments: optional("projectDepartments"),
      invitations: optional("invitations"),
    },
    publicWorkspaces: config.publicWorkspaces === true,
    publishedContent,
    memberContent: strings(config.memberContent, "memberContent"),
    comments: strings(config.comments, "comments"),
    ownedUploads: strings(config.ownedUploads, "ownedUploads"),
    objects,
  };
}

export async function loadAccessConfig(path: string): Promise<AccessConfig> {
  const source = await readFile(path, "utf8");
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length) {
    fail(ts.formatDiagnostics(errors, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }).trim());
  }
  if (/^\s*(?:import|export\s+\*)\b/m.test(result.outputText)) {
    fail("runtime imports are not supported; use `import type` in loomup.access.ts");
  }
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputText).toString("base64")}#${encodeURIComponent(path)}-${Date.now()}`;
  const loaded = await import(moduleUrl);
  return validateConfig(loaded.default);
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const and = (...parts: string[]) => `(${parts.join(") AND (")})`;
const or = (...parts: string[]) => `(${parts.join(") OR (")})`;

function access(read: string, create: string, update: string, remove: string): AccessOperations {
  return { read, create, update, delete: remove, subscribe: "false", notify: "false" };
}

function compileWorkspaceProject(shape: SchemaShape, config: WorkspaceProjectConfig): CompiledAccess {
  const choose = (override: string | undefined, role: string, candidates: string[]): string => {
    if (override) return override;
    const inferred = candidates.find((candidate) => shape.tables.has(candidate));
    return inferred ?? fail(`cannot infer the ${role} table; set tables.${role}`);
  };
  const overrides = config.tables ?? {};
  const t = {
    users: choose(overrides.users, "users", ["users", "user"]),
    workspaces: choose(overrides.workspaces, "workspaces", ["workspaces", "workspace"]),
    memberships: choose(overrides.memberships, "memberships", ["workspace_memberships", "memberships"]),
    projects: choose(overrides.projects, "projects", ["projects", "project"]),
    projectMembers: choose(overrides.projectMembers, "projectMembers", ["project_members", "project_memberships"]),
    departments: overrides.departments ?? (["departments", "department"].find((name) => shape.tables.has(name))),
    projectDepartments: overrides.projectDepartments ?? (["project_departments"].find((name) => shape.tables.has(name))),
    invitations: overrides.invitations ?? (["invitations", "invites"].find((name) => shape.tables.has(name))),
  };
  const configuredTables = [
    t.users, t.workspaces, t.memberships, t.projects, t.projectMembers,
    t.departments, t.projectDepartments, t.invitations,
    ...(config.publishedContent ?? []).flatMap((item) => [item.table, item.departments]),
    ...(config.memberContent ?? []), ...(config.comments ?? []),
    ...(config.ownedUploads ?? []), ...(config.objects ?? []).map((item) => item.table),
  ].filter((name): name is string => Boolean(name));
  for (const name of configuredTables) {
    if (!shape.tables.has(name)) fail(`table ${JSON.stringify(name)} does not exist in the schema`);
  }

  const table = (name: string) => shape.tables.get(name) ?? fail(`table ${JSON.stringify(name)} does not exist`);
  const field = (tableName: string, fieldName: string) => {
    if (!table(tableName).fields.has(fieldName)) fail(`field ${tableName}.${fieldName} does not exist`);
    return `row.${fieldName}`;
  };
  const relationPath = (from: string, to: string): Array<{ from: string; field: string; to: string }> | undefined => {
    if (from === to) return [];
    const queue: Array<{ name: string; path: Array<{ from: string; field: string; to: string }> }> = [{ name: from, path: [] }];
    const seen = new Set([from]);
    while (queue.length) {
      const current = queue.shift()!;
      for (const [fieldName, target] of table(current.name).fields) {
        if (!target || !shape.tables.has(target) || seen.has(target)) continue;
        const edge = { from: current.name, field: fieldName, to: target };
        const path = [...current.path, edge];
        if (target === to) return path;
        seen.add(target);
        queue.push({ name: target, path });
      }
    }
    return undefined;
  };
  const valueFrom = (from: string, target: string, targetField: string): string => {
    const path = relationPath(from, target);
    if (!path) fail(`cannot infer a relationship from ${from} to ${target}`);
    if (!path.length) return field(from, targetField);
    let idExpression = field(from, path[0]!.field);
    for (let index = 1; index < path.length; index += 1) {
      const previous = path[index - 1]!.to;
      idExpression = `lookup(${previous}, ${path[index]!.field}, id = ${idExpression})`;
    }
    if (targetField === "id") return idExpression;
    return `lookup(${target}, ${targetField}, id = ${idExpression})`;
  };
  const hasPath = (from: string, target: string) => relationPath(from, target) !== undefined;
  const nearestRoot = <T extends { table: string }>(from: string, roots: T[]): T | undefined =>
    roots
      .map((root) => ({ root, length: relationPath(from, root.table)?.length }))
      .filter((item): item is { root: T; length: number } => item.length !== undefined)
      .sort((a, b) => a.length - b.length)[0]?.root;

  const workspaceId = (from: string) => from === t.workspaces
    ? field(from, "id")
    : valueFrom(from, t.workspaces, "id");
  const projectId = (from: string) => from === t.projects
    ? field(from, "id")
    : valueFrom(from, t.projects, "id");
  const membership = (from: string, role?: string) => {
    const predicates = [`workspace_id = ${workspaceId(from)}`, "user_id = auth.uid()"];
    if (role) predicates.push(`role = ${quote(role)}`);
    return `exists(${t.memberships}, ${predicates.join(", ")})`;
  };
  const member = (from: string) => membership(from);
  const admin = (from: string) => or(membership(from, "owner"), membership(from, "admin"));
  const workspaceCreator = (from: string) =>
    `exists(${t.workspaces}, id = ${workspaceId(from)}, created_by = auth.uid())`;
  const editor = (from: string) => or(
    admin(from),
    `exists(${t.projects}, id = ${projectId(from)}, created_by = auth.uid())`,
    `exists(${t.projectMembers}, project_id = ${projectId(from)}, user_id = auth.uid())`,
  );
  const projectReader = (from: string) => {
    const project = projectId(from);
    const choices = [
      editor(from),
      `exists(${t.projects}, id = ${project}, visibility = 'public')`,
      and(member(from), `exists(${t.projects}, id = ${project}, audience = 'everyone')`),
    ];
    if (t.projectDepartments) {
      choices.push(`exists(${t.projectDepartments}, project_id = ${project}, department_id = lookup(${t.memberships}, department_id, workspace_id = ${workspaceId(from)}, user_id = auth.uid()))`);
    }
    return or(...choices);
  };

  const publishedRoots = config.publishedContent ?? [];
  const publishedReader = (from: string, root: PublishedContent) => {
    const status = valueFrom(from, root.table, root.statusField ?? "status");
    const rootId = valueFrom(from, root.table, "id");
    const audienceField = root.audienceField === undefined ? "audience" : root.audienceField;
    const audience = audienceField === null ? undefined : valueFrom(from, root.table, audienceField);
    const audienceRules = !audience
      ? "true"
      : root.departments
        ? or(
            `${audience} = 'everyone'`,
            `exists(${root.departments}, ${root.departmentContentField ?? `${root.table.replace(/s$/, "")}_id`} = ${rootId}, department_id = lookup(${t.memberships}, department_id, workspace_id = ${workspaceId(from)}, user_id = auth.uid()))`,
          )
        : `${audience} = 'everyone'`;
    return or(
      editor(from),
      and(`${status} = ${quote(root.publishedValue ?? "published")}`, projectReader(from), audienceRules),
    );
  };

  const authenticated = "auth.uid() != null";
  const deny = "false";
  const compiled: CompiledAccess = { tables: {}, buckets: {} };
  for (const tableName of shape.tables.keys()) {
    let rules: AccessOperations;
    if (tableName === t.users) {
      const self = `${field(tableName, "id")} = auth.uid()`;
      rules = access(authenticated, self, self, deny);
    } else if (tableName === t.workspaces) {
      const manage = admin(tableName);
      rules = access(config.publicWorkspaces ? "true" : member(tableName), authenticated, manage, manage);
    } else if (tableName === t.memberships) {
      const invited = t.invitations
        ? and(
            `${field(tableName, "user_id")} = auth.uid()`,
            `${field(tableName, "invitation_token_hash")} != null`,
            `${field(tableName, "workspace_id")} = lookup(${t.invitations}, workspace_id, token_hash = ${field(tableName, "invitation_token_hash")}, email = lookup(${t.users}, email, id = auth.uid()), expires_at > now(), accepted_at = null, revoked_at = null)`,
            `${field(tableName, "role")} = lookup(${t.invitations}, role, token_hash = ${field(tableName, "invitation_token_hash")})`,
            `${field(tableName, "department_id")} = lookup(${t.invitations}, department_id, token_hash = ${field(tableName, "invitation_token_hash")})`,
          )
        : deny;
      rules = access(member(tableName), or(workspaceCreator(tableName), invited), admin(tableName), admin(tableName));
    } else if (tableName === t.invitations) {
      const recipient = `${field(tableName, "email")} = lookup(${t.users}, email, id = auth.uid())`;
      rules = access(or(admin(tableName), recipient), admin(tableName), admin(tableName), or(admin(tableName), recipient));
    } else if (tableName === t.projects) {
      const read = or(`${field(tableName, "visibility")} = 'public'`, member(tableName));
      rules = access(read, member(tableName), editor(tableName), editor(tableName));
    } else if (tableName === t.projectMembers) {
      const read = or(`${field(tableName, "user_id")} = auth.uid()`, editor(tableName));
      rules = access(read, editor(tableName), editor(tableName), editor(tableName));
    } else if (tableName === t.projectDepartments) {
      const ownDepartment = `${field(tableName, "department_id")} = lookup(${t.memberships}, department_id, workspace_id = ${workspaceId(tableName)}, user_id = auth.uid())`;
      rules = access(or(ownDepartment, editor(tableName)), editor(tableName), editor(tableName), editor(tableName));
    } else if ((config.ownedUploads ?? []).includes(tableName)) {
      const owned = `${field(tableName, "created_by")} = auth.uid()`;
      rules = access(owned, and(owned, editor(tableName)), owned, owned);
    } else if ((config.comments ?? []).includes(tableName)) {
      const read = and(member(tableName), projectReader(tableName));
      const owned = `${field(tableName, "created_by")} = auth.uid()`;
      rules = access(read, and(owned, read), and(owned, read), and(owned, read));
    } else {
      const commentRoot = nearestRoot(tableName, (config.comments ?? []).map((name) => ({ table: name })));
      const publishedRoot = nearestRoot(tableName, publishedRoots);
      const memberRoot = nearestRoot(tableName, (config.memberContent ?? []).map((name) => ({ table: name })));
      const publishedDepartment = publishedRoots.find((root) => root.departments === tableName);
      if (commentRoot) {
        const read = and(member(tableName), projectReader(tableName));
        const parentOwned = `${valueFrom(tableName, commentRoot.table, "created_by")} = auth.uid()`;
        rules = access(read, and(parentOwned, read), deny, and(parentOwned, read));
      } else if (publishedDepartment) {
        const ownDepartment = `${field(tableName, "department_id")} = lookup(${t.memberships}, department_id, workspace_id = ${workspaceId(tableName)}, user_id = auth.uid())`;
        rules = access(or(ownDepartment, editor(tableName)), editor(tableName), editor(tableName), editor(tableName));
      } else if (publishedRoot) {
        rules = access(publishedReader(tableName, publishedRoot), editor(tableName), editor(tableName), editor(tableName));
      } else if (memberRoot) {
        const read = and(member(tableName), projectReader(tableName));
        rules = access(read, editor(tableName), editor(tableName), editor(tableName));
      } else if (hasPath(tableName, t.projects)) {
        rules = access(projectReader(tableName), editor(tableName), editor(tableName), editor(tableName));
      } else if (hasPath(tableName, t.workspaces)) {
        rules = access(
          member(tableName),
          or(admin(tableName), workspaceCreator(tableName)),
          admin(tableName),
          admin(tableName),
        );
      } else {
        rules = access(authenticated, authenticated, authenticated, authenticated);
      }
    }
    compiled.tables[tableName] = rules;
  }

  for (const bucket of shape.buckets) {
    const objectRules = (config.objects ?? []).map(({ table: objectTable, pathField = "r2_key" }) => {
      field(objectTable, pathField);
      const convert = (rule: string) => rule.replace(/row\.([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) =>
        `lookup(${objectTable}, ${name}, ${pathField} = row.path)`);
      const tableRules = compiled.tables[objectTable]!;
      return { read: convert(tableRules.read), manage: convert(tableRules.update) };
    });
    const owner = "row.owner_id = auth.uid()";
    compiled.buckets[bucket] = access(
      or(owner, ...objectRules.map((rules) => rules.read)),
      authenticated,
      or(owner, ...objectRules.map((rules) => rules.manage)),
      or(owner, ...objectRules.map((rules) => rules.manage)),
    );
  }
  return compiled;
}

export function compileAccess(schemaSource: string, config: AccessConfig): CompiledAccess {
  const shape = parseSchema(schemaSource);
  if (config.profile === "authenticated") {
    const authenticated = access(
      "auth.uid() != null",
      "auth.uid() != null",
      "auth.uid() != null",
      "auth.uid() != null",
    );
    return {
      tables: Object.fromEntries([...shape.tables.keys()].map((name) => [name, authenticated])),
      buckets: Object.fromEntries(shape.buckets.map((name) => [name, authenticated])),
    };
  }
  return compileWorkspaceProject(shape, config);
}

export async function loadAndCompileAccess(schemaSource: string, path?: string): Promise<CompiledAccess | undefined> {
  if (!path) return undefined;
  try {
    return compileAccess(schemaSource, await loadAccessConfig(path));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
