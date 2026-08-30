import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import Database from "better-sqlite3";

import { HarnessError } from "./errors.js";
import type {
  CaptureRoot,
  CaptureSpec,
  EventCaptureSpec,
  EventRecord,
  RunRecord,
  RuntimePaths,
  SqliteCaptureSpec,
  SqliteRecord,
  SqliteValue,
  TreeEntry,
} from "./types.js";

function rootPath(paths: RuntimePaths, root: CaptureRoot): string {
  return paths[root];
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function excluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function captureTree(root: string, exclusions: readonly string[]): readonly TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const absolute = join(directory, name);
      const path = portablePath(root, absolute);
      if (excluded(path, exclusions)) {
        continue;
      }
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        entries.push({ path, type: "symlink", target: readlinkSync(absolute) });
      } else if (stats.isDirectory()) {
        entries.push({ path, type: "directory" });
        visit(absolute);
      } else if (stats.isFile()) {
        entries.push({
          path,
          type: "file",
          size: stats.size,
          sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        });
      }
    }
  };
  visit(root);
  return entries;
}

function sqliteValue(value: unknown, storageClass?: string): SqliteValue {
  if (storageClass === "null") return null;
  if (storageClass === "integer") {
    if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
      throw new HarnessError("SQLITE_INTEGER_UNSAFE", "SQLite INTEGER is not lossless");
    }
    return { type: "integer", decimal: value.toString() };
  }
  if (storageClass === "real") {
    if (typeof value !== "number") {
      throw new HarnessError("SQLITE_VALUE", "SQLite REAL was not returned as a number");
    }
    return { type: "real", value };
  }
  if (storageClass === "text") {
    if (typeof value !== "string") {
      throw new HarnessError("SQLITE_VALUE", "SQLite TEXT was not returned as a string");
    }
    return value;
  }
  if (storageClass === "blob") {
    if (!Buffer.isBuffer(value)) {
      throw new HarnessError("SQLITE_VALUE", "SQLite BLOB was not returned as bytes");
    }
    return { type: "blob", base64: value.toString("base64") };
  }
  if (storageClass !== undefined) {
    throw new HarnessError("SQLITE_VALUE", `Unsupported SQLite storage class ${storageClass}`);
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return { type: "integer", decimal: value.toString() };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", decimal: value.toString() }
      : { type: "real", value };
  }
  if (Buffer.isBuffer(value)) {
    return { type: "blob", base64: value.toString("base64") };
  }
  throw new HarnessError("SQLITE_VALUE", `Unsupported SQLite value type ${typeof value}`);
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new HarnessError("SQLITE_IDENTIFIER", `${label} is not a safe SQLite identifier`);
  }
  return `"${value}"`;
}

function captureSqlite(root: string, spec: SqliteCaptureSpec): SqliteRecord {
  const path = join(root, spec.path);
  if (!existsSync(path)) {
    return { exists: false };
  }
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    database.defaultSafeIntegers(true);
    const schema = database
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    const pragmaEntries = spec.pragmas.map((name) => {
      const value = database?.pragma(name, { simple: true });
      return [name, sqliteValue(value)] as const;
    });
    const tables = Object.fromEntries(
      spec.tables.map((table) => {
        const tableName = identifier(table.name, `SQLite table ${table.name}`);
        const info = database?.pragma(`table_info(${tableName})`) as Record<string, unknown>[];
        const columns = info.map((column) => String(column.name));
        for (const orderColumn of table.orderBy) {
          if (!columns.includes(orderColumn)) {
            throw new HarnessError(
              "SQLITE_ORDER_COLUMN",
              `SQLite table ${table.name} has no order column ${orderColumn}`,
            );
          }
        }
        const order = table.orderBy
          .map((column) => identifier(column, `SQLite order column ${column}`))
          .join(", ");
        const projection = columns
          .flatMap((column) => {
            const name = identifier(column, `SQLite column ${column}`);
            return [name, `typeof(${name})`];
          })
          .join(", ");
        const rows = database
          ?.prepare(`SELECT ${projection} FROM ${tableName} ORDER BY ${order}`)
          .raw(true)
          .all() as unknown[][];
        return [
          table.name,
          {
            columns,
            rows: rows.map((row) =>
              columns.map((_, index) => sqliteValue(row[index * 2], String(row[index * 2 + 1]))),
            ),
          },
        ] as const;
      }),
    );
    return {
      exists: true,
      schema,
      pragmas: Object.fromEntries(pragmaEntries),
      tables,
    };
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("SQLITE_CAPTURE", `Failed to capture SQLite ${spec.path}`, {
      cause: error,
    });
  } finally {
    database?.close();
  }
}

function captureEvents(root: string, spec: EventCaptureSpec): EventRecord {
  const path = join(root, spec.path);
  if (!existsSync(path)) {
    return { exists: false };
  }
  const text = readFileSync(path, "utf8");
  try {
    if (spec.format === "json") {
      return { exists: true, records: JSON.parse(text) as unknown };
    }
    const records = text
      .split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.length > 0)
      .map(({ line, index }) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new HarnessError(
            "EVENT_JSONL",
            `Invalid JSONL in ${spec.path} at line ${String(index + 1)}`,
            { cause: error },
          );
        }
      });
    return { exists: true, records };
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("EVENT_JSON", `Invalid JSON in ${spec.path}`, { cause: error });
  }
}

export function captureObservables(
  pathsOrProfile: RuntimePaths | string,
  spec: CaptureSpec,
): Pick<RunRecord, "tree" | "sqlite" | "events"> {
  const paths: RuntimePaths =
    typeof pathsOrProfile === "string"
      ? {
          root: pathsOrProfile,
          home: pathsOrProfile,
          profile: pathsOrProfile,
          sandbox: pathsOrProfile,
        }
      : pathsOrProfile;
  const treeRoot = rootPath(paths, spec.tree.root);
  const tree = spec.tree.enabled ? captureTree(treeRoot, spec.tree.exclude) : [];
  const sqlite = Object.fromEntries(
    spec.sqlite.map((entry) => [entry.name, captureSqlite(rootPath(paths, entry.root), entry)]),
  );
  const events = Object.fromEntries(
    spec.events.map((entry) => [entry.name, captureEvents(rootPath(paths, entry.root), entry)]),
  );
  return { tree, sqlite, events };
}
