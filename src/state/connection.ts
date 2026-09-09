import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { resolvePaths } from "../config/paths.js";
import { StateError } from "./errors.js";
import {
  addedColumns,
  applicationSchema,
  ftsBackfill,
  ftsSchema,
  schemaVersion,
} from "./schema.js";

export interface StateConnectionOptions {
  readonly ftsAvailable?: boolean;
  readonly journalMode?: (database: Database.Database, mode: "WAL" | "DELETE") => unknown;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface StateConnection {
  readonly database: Database.Database;
  readonly ftsEnabled: boolean;
  readonly journalMode: "wal" | "delete";
  readonly journalFallback: boolean;
  close(): void;
}

function setJournalMode(
  database: Database.Database,
  mode: "WAL" | "DELETE",
  override?: StateConnectionOptions["journalMode"],
): string {
  const value =
    override?.(database, mode) ?? database.pragma(`journal_mode = ${mode}`, { simple: true });
  return String(value).toLowerCase();
}

function configureJournal(
  database: Database.Database,
  override?: StateConnectionOptions["journalMode"],
): { readonly mode: "wal" | "delete"; readonly fallback: boolean } {
  try {
    if (setJournalMode(database, "WAL", override) === "wal") {
      return { mode: "wal", fallback: false };
    }
  } catch {
    // The explicit DELETE fallback below is the only recovery path.
  }
  let fallback: string;
  try {
    fallback = setJournalMode(database, "DELETE", override);
  } catch (error) {
    throw new StateError("SQLITE_JOURNAL_MODE", "WAL and DELETE journal modes both failed", {
      cause: error,
    });
  }
  if (fallback !== "delete") {
    throw new StateError(
      "SQLITE_JOURNAL_MODE",
      `DELETE journal fallback returned unsupported mode ${fallback}`,
    );
  }
  return { mode: "delete", fallback: true };
}

function addMissingColumns(database: Database.Database): void {
  for (const [table, column, declaration] of addedColumns) {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
}

function setupFts(database: Database.Database, enabled: boolean): boolean {
  if (!enabled) return false;
  try {
    database.exec(ftsSchema);
  } catch (error) {
    if (error instanceof Error && /fts5|no such module/i.test(error.message)) return false;
    throw error;
  }
  const row = database.prepare("SELECT count(*) AS count FROM messages_fts").get() as {
    readonly count: bigint;
  };
  if (row.count === 0n) database.exec(ftsBackfill);
  return true;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const NON_NEGATIVE_INTEGER = /^\d+$/;

function resolveBusyTimeoutMs(environment: Readonly<Record<string, string | undefined>>): number {
  const raw = environment.LOHRA_SQLITE_BUSY_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_BUSY_TIMEOUT_MS;
  if (NON_NEGATIVE_INTEGER.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new StateError(
    "SQLITE_BUSY_TIMEOUT_INVALID",
    `invalid LOHRA_SQLITE_BUSY_TIMEOUT_MS='${raw}': expected an integer >= 0`,
  );
}

export function stateDatabasePath(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolvePaths(environment).home, "state.db");
}

export function openStateDatabase(
  path: string,
  options: StateConnectionOptions = {},
): StateConnection {
  const busyTimeoutMs = resolveBusyTimeoutMs(options.environment ?? process.env);
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.defaultSafeIntegers(true);
  try {
    database.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
    database.pragma("foreign_keys = OFF");
    const journal = configureJournal(database, options.journalMode);
    database.exec(applicationSchema);
    addMissingColumns(database);
    database
      .prepare("INSERT OR IGNORE INTO state_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(schemaVersion));
    const ftsEnabled = setupFts(database, options.ftsAvailable ?? true);
    return {
      database,
      ftsEnabled,
      journalMode: journal.mode,
      journalFallback: journal.fallback,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function openStateForEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: StateConnectionOptions = {},
): StateConnection {
  return openStateDatabase(stateDatabasePath(environment), {
    ...options,
    environment: options.environment ?? environment,
  });
}
