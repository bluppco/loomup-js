import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

const DEFAULT_CLIENT_PATH = ".loomup/client.ts";

type FieldObject = {
  type?: unknown;
  enum?: unknown;
  default?: unknown;
};

type ParsedField = {
  name: string;
  token?: string;
  enumValues: string[];
  nullable: boolean;
  generatedId: boolean;
  hasDefault: boolean;
};

type ParsedTable = {
  name: string;
  interfaceName: string;
  fields: ParsedField[];
  primaryKey: Set<string>;
};

export type GenerateClientOptions = {
  schemaPath: string;
  projectRoot: string;
  platformUrl?: string;
  projectId?: string;
  outputPath?: string;
};

export type GeneratedClient = {
  outputPath: string;
  source: string;
};

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function typeName(value: string): string {
  let output = "";
  let uppercase = true;
  for (const character of value) {
    if (/[A-Za-z0-9]/.test(character)) {
      output += uppercase ? character.toUpperCase() : character;
      uppercase = false;
    } else {
      uppercase = true;
    }
  }
  if (!output) return "Row";
  return /^\d/.test(output) ? `T${output}` : output;
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function parseField(table: string, name: string, value: unknown): ParsedField {
  let token: string | undefined;
  let enumValues: string[] = [];
  let hasExplicitDefault = false;
  let explicitDefault: unknown;

  if (typeof value === "string") {
    token = value;
  } else {
    const definition = object(value, `field \`${table}.${name}\``) as FieldObject;
    const unknown = Object.keys(definition).filter(
      (key) => key !== "type" && key !== "enum" && key !== "default",
    );
    if (unknown.length) {
      throw new Error(`unknown option \`${unknown[0]}\` on field \`${table}.${name}\``);
    }
    const hasType = Object.prototype.hasOwnProperty.call(definition, "type");
    const hasEnum = Object.prototype.hasOwnProperty.call(definition, "enum");
    if (hasType === hasEnum) {
      throw new Error(`field \`${table}.${name}\` must declare exactly one of type or enum`);
    }
    if (typeof definition.type === "string") {
      token = definition.type;
    } else if (Array.isArray(definition.enum)) {
      if (
        !definition.enum.length ||
        definition.enum.some((entry) => typeof entry !== "string" || entry.length === 0) ||
        new Set(definition.enum).size !== definition.enum.length
      ) {
        throw new Error(`field \`${table}.${name}\` enum must contain unique, non-empty strings`);
      }
      enumValues = definition.enum as string[];
    } else {
      throw new Error(`field \`${table}.${name}\` must declare a type or enum`);
    }
    hasExplicitDefault = Object.prototype.hasOwnProperty.call(definition, "default");
    explicitDefault = definition.default;
  }

  const nullable = token?.endsWith("?") ?? false;
  const normalized = token?.replace(/\?$/, "").trim();
  if (token !== undefined && !normalized) {
    throw new Error(`field \`${table}.${name}\` has an empty type`);
  }
  if (normalized === "id" && name !== "id") {
    throw new Error(`the id type is only valid for the id field, not \`${table}.${name}\``);
  }
  if (normalized === "id" && nullable) {
    throw new Error(`the generated id field \`${table}.${name}\` cannot be nullable`);
  }
  const generatedId = name === "id" && normalized === "id";
  const conventionalDefault =
    generatedId ||
    normalized === "boolean" ||
    (normalized === "datetime" && (name === "created_at" || name === "updated_at"));
  const hasDefault = hasExplicitDefault ? explicitDefault !== null : conventionalDefault;

  return {
    name,
    token: normalized,
    enumValues,
    nullable,
    generatedId,
    hasDefault,
  };
}

function primaryKey(table: string, _fields: ParsedField[], indexes: unknown): Set<string> {
  for (const entry of Array.isArray(indexes) ? indexes : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = (entry as Record<string, unknown>).primary;
    if (value !== undefined) {
      throw new Error(
        `table \`${table}\` primary key is managed by Loomup; use \`unique\` for natural or composite keys`,
      );
    }
  }
  return new Set(["id"]);
}

function parseSchema(source: string): ParsedTable[] {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new Error(`invalid schema YAML: ${String(error)}`);
  }
  const root = object(value, "schema root");
  if (!Object.keys(root).length) throw new Error("schema must declare at least one table");

  const projectMetadata = new Set(["$buckets", "$policies", "$auth", "$email", "$origins"]);
  for (const key of Object.keys(root).filter((key) => key.startsWith("$"))) {
    if (!projectMetadata.has(key)) throw new Error(`unknown project metadata \`${key}\``);
  }
  if (root.$buckets !== undefined) {
    const bucketNames = Array.isArray(root.$buckets)
      ? root.$buckets
      : Object.keys(object(root.$buckets, "`$buckets`"));
    if (
      bucketNames.some(
        (bucket) =>
          typeof bucket !== "string" ||
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(bucket),
      )
    ) {
      throw new Error("`$buckets` must contain valid lowercase bucket names");
    }
  }

  const usedNames = new Map<string, number>();
  const tableEntries = Object.entries(root).filter(([name]) => !name.startsWith("$"));
  if (!tableEntries.length) throw new Error("schema must declare at least one table");
  return tableEntries.map(([tableName, tableValue]) => {
    const definition = object(tableValue, `table \`${tableName}\``);
    for (const key of Object.keys(definition).filter((key) => key.startsWith("$"))) {
      if (key !== "$indexes" && key !== "$access") {
        throw new Error(`unknown table metadata \`${key}\` on \`${tableName}\``);
      }
    }
    const fields = Object.entries(definition)
      .filter(([name]) => name !== "$indexes" && name !== "$access")
      .map(([name, field]) => {
        if (name === "id") {
          throw new Error(`field \`${tableName}.id\` is managed by Loomup and must not be declared`);
        }
        return parseField(tableName, name, field);
      });
    const keys = primaryKey(tableName, fields, definition.$indexes);
    if (keys.has("id") && !fields.some((field) => field.name === "id")) {
      fields.unshift({
        name: "id",
        token: "id",
        enumValues: [],
        nullable: false,
        generatedId: true,
        hasDefault: true,
      });
    }
    const baseName = typeName(tableName);
    const occurrence = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, occurrence);
    return {
      name: tableName,
      interfaceName: occurrence === 1 ? baseName : `${baseName}${occurrence}`,
      fields,
      primaryKey: keys,
    };
  });
}

function fieldType(field: ParsedField, tables: Map<string, ParsedTable>, seen = new Set<string>()): string {
  if (field.enumValues.length) {
    return field.enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }
  switch (field.token) {
    case "id":
    case "text":
      return "string";
    case "integer":
    case "real":
    case "datetime":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return "JsonValue";
    default: {
      if (!field.token) return "string";
      if (seen.has(field.token)) return "string";
      const target = tables.get(field.token);
      if (!target) {
        throw new Error(`field type references unknown table \`${field.token}\``);
      }
      if (target.primaryKey.size !== 1) {
        throw new Error(`field type cannot reference composite-key table \`${field.token}\``);
      }
      const key = [...target.primaryKey][0]!;
      const targetField = target.fields.find((candidate) => candidate.name === key);
      if (!targetField) return "string";
      return fieldType(targetField, tables, new Set([...seen, field.token]));
    }
  }
}

function projectGateway(platformUrl?: string, projectId?: string): string | undefined {
  if (!platformUrl || !projectId) return undefined;
  return `${platformUrl.replace(/\/$/, "")}/p/${encodeURIComponent(projectId)}`;
}

export function generateClientSource(
  schemaSource: string,
  options: Pick<GenerateClientOptions, "platformUrl" | "projectId"> = {},
): string {
  const tables = parseSchema(schemaSource);
  const tableMap = new Map(tables.map((table) => [table.name, table]));
  const gateway = projectGateway(options.platformUrl, options.projectId);
  const lines: string[] = [
    "/**",
    " * Generated by Loomup from loomup.schema.yaml. Do not edit by hand.",
    " */",
    "",
    "import {",
    "  createProject,",
    "  type CreateClientOptions,",
    "  type LoomupProject,",
    '} from "@loomup/client";',
    "",
    "export type JsonValue =",
    "  | string",
    "  | number",
    "  | boolean",
    "  | null",
    "  | JsonValue[]",
    "  | { [key: string]: JsonValue };",
    "",
  ];

  for (const table of tables) {
    for (const [suffix, mode] of [
      ["", "select"],
      ["Insert", "insert"],
      ["Update", "update"],
    ] as const) {
      lines.push(`export interface ${table.interfaceName}${suffix} {`);
      for (const field of table.fields) {
        if (mode === "update" && table.primaryKey.has(field.name)) continue;
        if (mode === "insert" && field.generatedId) continue;
        const baseType = fieldType(field, tableMap);
        const nullable = field.nullable && !table.primaryKey.has(field.name);
        const type = nullable ? `${baseType} | null` : baseType;
        const optional =
          mode === "update" ||
          (mode === "insert" &&
            (field.hasDefault || (field.nullable && !table.primaryKey.has(field.name))));
        lines.push(`  ${propertyName(field.name)}${optional ? "?" : ""}: ${type};`);
      }
      lines.push("}", "");
    }
  }

  lines.push("export interface TableMap {");
  for (const table of tables) lines.push(`  ${JSON.stringify(table.name)}: ${table.interfaceName};`);
  lines.push("}", "", "export interface TableInsertMap {");
  for (const table of tables) {
    lines.push(`  ${JSON.stringify(table.name)}: ${table.interfaceName}Insert;`);
  }
  lines.push("}", "", "export interface TableUpdateMap {");
  for (const table of tables) {
    lines.push(`  ${JSON.stringify(table.name)}: ${table.interfaceName}Update;`);
  }
  lines.push(
    "}",
    "",
    "export type Db = LoomupProject<TableMap, TableInsertMap, TableUpdateMap>;",
    "",
    'export type CreateDbOptions = Omit<CreateClientOptions, "url"> & { url?: string };',
    "",
    `const generatedProjectUrl: string | undefined = ${gateway ? JSON.stringify(gateway) : "undefined"};`,
    "",
    "export function createDb(options: CreateDbOptions = {}): Db {",
    "  const url = options.url ?? generatedProjectUrl;",
    "  if (!url) {",
    '    throw new Error("Loomup project URL is missing; run `loomup link` or set LOOMUP_PROJECT_URL");',
    "  }",
    "  return createProject<TableMap, TableInsertMap, TableUpdateMap>({",
    "    ...options,",
    "    url,",
    "  });",
    "}",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function generateClient(options: GenerateClientOptions): Promise<GeneratedClient> {
  const schemaSource = await readFile(options.schemaPath, "utf8");
  const source = generateClientSource(schemaSource, options);
  const outputPath = resolve(options.projectRoot, options.outputPath ?? DEFAULT_CLIENT_PATH);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, "utf8");
  return { outputPath, source };
}

export { DEFAULT_CLIENT_PATH };
