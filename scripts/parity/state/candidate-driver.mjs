import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import Database from "better-sqlite3";

import { pythonFloat, pythonJsonDumps } from "../../../dist/serialization/python-json.js";
import {
  LockRepository,
  openStateDatabase,
  SessionRepository,
  stateDatabasePath,
} from "../../../dist/state/index.js";

function emit(value) {
  process.stdout.write(`${pythonJsonDumps(value)}\n`);
}

function root() {
  return process.env.LOHRA_PARITY_PROFILE;
}

function usageOutput(usage) {
  return {
    actual_cost_usd: usage.actualCostUsd === null ? null : pythonFloat(usage.actualCostUsd),
    api_calls: usage.apiCallCount,
    estimated_cost_usd:
      usage.estimatedCostUsd === null ? null : pythonFloat(usage.estimatedCostUsd),
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    priced_call_count: usage.pricedCallCount,
  };
}

function core() {
  const connection = openStateDatabase(join(root(), "state.db"));
  try {
    const repo = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
    repo.createSession({
      id: "fk-child",
      parentSessionId: "missing-parent",
      startedAt: 999,
    });
    connection.database.prepare("DELETE FROM sessions WHERE id='fk-child'").run();
    repo.createSession({ id: "core", model: "stub-model", title: "core", startedAt: 1000 });
    repo.appendMessage("core", {
      role: "user",
      content: "hello stub world",
      createdAt: 1001,
    });
    repo.appendMessage("core", {
      role: "assistant",
      content: null,
      finishReason: "tool_calls",
      createdAt: 1002,
      toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a": 1}' } }],
      providerData: { z: 2, a: 1 },
    });
    repo.appendMessage("core", {
      role: "tool",
      name: "f",
      toolCallId: "c1",
      content: "ok",
      createdAt: 1003,
    });
    repo.addUsage("core", {
      inputTokens: 11,
      outputTokens: 7,
      apiCalls: 2,
      realUsd: 0,
      grossUsd: 0.5,
    });
    repo.addUsage("core", { inputTokens: 1, outputTokens: 1, apiCalls: 1 });
    const row = connection.database
      .prepare(
        "SELECT tool_calls, reasoning_details, typeof(actual_cost_usd) AS actual_type, " +
          "typeof(api_call_count) AS calls_type, started_at FROM sessions JOIN messages " +
          "ON messages.session_id=sessions.id WHERE messages.id=2",
      )
      .get();
    const version = connection.database
      .prepare("SELECT value FROM state_meta WHERE key='schema_version'")
      .pluck()
      .get();
    emit({
      foreignKeyOff: true,
      messages: repo.loadMessages("core"),
      schemaVersion: version,
      storage: {
        actualCost: row.actual_type,
        apiCalls: row.calls_type,
        startedAt: pythonFloat(row.started_at),
        storedProviderData: row.reasoning_details,
        storedToolCalls: row.tool_calls,
      },
      usage: usageOutput(repo.usage("core")),
    });
  } finally {
    connection.close();
  }
}

function profileIsolation() {
  const base = root();
  const paths = {};
  for (const [profile, sentinel, startedAt] of [
    [null, "default", 1],
    ["p1", "one", 2],
    ["p2", "two", 3],
  ]) {
    const environment = {
      HOME: process.env.HOME,
      LOHRA_HOME: base,
      ...(profile ? { LOHRA_PROFILE: profile } : {}),
    };
    const path = stateDatabasePath(environment);
    const connection = openStateDatabase(path);
    try {
      new SessionRepository(connection.database).createSession({ id: sentinel, startedAt });
    } finally {
      connection.close();
    }
    paths[profile ?? "default"] = path;
  }
  const visible = {};
  for (const profile of [null, "p1", "p2"]) {
    const environment = {
      HOME: process.env.HOME,
      LOHRA_HOME: base,
      ...(profile ? { LOHRA_PROFILE: profile } : {}),
    };
    const connection = openStateDatabase(stateDatabasePath(environment));
    try {
      visible[profile ?? "default"] = new SessionRepository(connection.database)
        .listSessions()
        .map((row) => row.id);
    } finally {
      connection.close();
    }
  }
  emit({ paths, visible });
}

function ftsLineage() {
  const path = join(root(), "state.db");
  const connection = openStateDatabase(path);
  const repo = new SessionRepository(connection.database, () => 0, connection.ftsEnabled);
  let result;
  try {
    let parent = null;
    for (let index = 0; index < 105; index += 1) {
      const id = `lin-${String(index).padStart(4, "0")}`;
      repo.createSession({ id, parentSessionId: parent, startedAt: index });
      parent = id;
    }
    repo.createSession({ id: "s1", startedAt: 1000 });
    repo.createSession({ id: "s-arch", startedAt: 999 });
    repo.createSession({ id: "s-orch", source: "orchestration", startedAt: 998 });
    connection.database.prepare("UPDATE sessions SET archived=1 WHERE id='s-arch'").run();
    repo.appendMessage("lin-0104", {
      role: "user",
      content: "hello stub world",
      createdAt: 200,
    });
    result = {
      blank: repo.searchMessages("   "),
      default: repo.listSessions({ limit: 200 }).map((row) => row.id),
      includeArchived: repo
        .listSessions({ limit: 200, includeArchived: true })
        .map((row) => row.id),
      lineage: repo.lineageRootToTip("lin-0104"),
      malformed: repo.searchMessages("AND OR (( NEAR"),
      search: repo.searchMessages("hello stub"),
    };
  } finally {
    connection.close();
  }
  const reopened = openStateDatabase(path);
  try {
    result.searchAfterReopen = new SessionRepository(
      reopened.database,
      () => 0,
      reopened.ftsEnabled,
    ).searchMessages("hello stub");
  } finally {
    reopened.close();
  }
  emit(result);
}

function locksSequential(mutant = false) {
  const connection = openStateDatabase(join(root(), "state.db"));
  const warnings = [];
  const locks = new LockRepository(connection.database, (warning) => warnings.push(warning));
  try {
    const compression = {
      p1_acquire: locks.acquireCompressionLock("s", "p1", 10, 5),
      p2_contended: locks.acquireCompressionLock("s", "p2", 11, 5),
      release_wrong_holder: locks.releaseCompressionLock("s", "wrong"),
    };
    compression.p2_after_ttl = locks.acquireCompressionLock("s", "p2", 15, 5);
    compression.release_right_holder = locks.releaseCompressionLock("s", "p2");
    const first = locks.acquireRunLease("run-stale", "p1", 10, 1);
    locks.tryWriteProbeRunState("run-stale", "p1", "running", 10, first);
    locks.releaseRunLease("run-stale", "p1");
    const second = locks.acquireRunLease("run-stale", "p2", 11, 1);
    locks.tryWriteProbeRunState("run-stale", "p2", "running", 11, second);
    let stale;
    if (mutant) {
      connection.database
        .prepare(
          "UPDATE workflow_run_state SET owner='p1', status='complete' WHERE run_id='run-stale'",
        )
        .run();
      stale = true;
    } else {
      stale = locks.tryWriteProbeRunState("run-stale", "p1", "complete", 12, first);
    }
    const final = connection.database
      .prepare("SELECT owner,status FROM workflow_run_state WHERE run_id='run-stale'")
      .get();
    locks.releaseRunLease("run-stale", "p2");
    const third = locks.acquireRunLease("run-stale", "p3", 12, 1);
    locks.releaseRunLease("run-stale", "p3");
    emit({
      compression,
      fences: [first, second, third],
      final,
      fenceAfterRelease: locks.runFenceOf("run-stale"),
      staleAccepted: stale,
      warnings,
    });
  } finally {
    connection.close();
  }
}

function storageTypes() {
  mkdirSync(root(), { recursive: true });
  const database = new Database(join(root(), "typed.db"));
  try {
    database.exec("CREATE TABLE typed_values (id INTEGER PRIMARY KEY, n, i, r, t, b BLOB)");
    database
      .prepare("INSERT INTO typed_values VALUES (?, ?, CAST(? AS INTEGER), CAST(? AS REAL), ?, ?)")
      .run(1, null, 42, 0, "café — state", Buffer.from([0, 255, 128, 65]));
    const row = database
      .prepare(
        "SELECT n,i,r,t,b,typeof(n) ntype,typeof(i) itype,typeof(r) rtype," +
          "typeof(t) ttype,typeof(b) btype FROM typed_values",
      )
      .get();
    emit({
      classes: [row.ntype, row.itype, row.rtype, row.ttype, row.btype],
      real: pythonFloat(row.r),
      text: row.t,
      blob: row.b.toString("hex"),
    });
  } finally {
    database.close();
  }
}

function liveSchemaAnchor(argv) {
  const profileIndex = argv.indexOf("--profile");
  const profile = profileIndex >= 0 ? argv[profileIndex + 1] : null;
  const path = stateDatabasePath({
    HOME: process.env.HOME,
    ...(profile ? { LOHRA_PROFILE: profile } : {}),
  });
  const connection = openStateDatabase(path);
  try {
    new SessionRepository(connection.database).createSession({
      id: "t03-candidate-schema-anchor",
      model: "m",
      startedAt: Date.now() / 1000,
    });
  } finally {
    connection.close();
  }
}

const [action, ...argv] = process.argv.slice(2);
if (action === "core") core();
else if (action === "profile-isolation") profileIsolation();
else if (action === "fts-lineage") ftsLineage();
else if (action === "locks-sequential") locksSequential();
else if (action === "storage-types") storageTypes();
else if (action === "stale-write-mutant") locksSequential(true);
else if (action === "live-schema-anchor") liveSchemaAnchor(argv);
else throw new Error(`unknown state action: ${action}`);
