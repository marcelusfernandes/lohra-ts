import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { openStateDatabase, SessionRepository } from "../../../dist/state/index.js";

import {
  canonicalJson,
  cleanEnvironment,
  guardAfter,
  guardBefore,
  parseJsonOutput,
  parseWorkspace,
  runBounded,
  writeEvidence,
} from "./probe-utils.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pythonDriver = join(projectRoot, "scripts/parity/state/cross-read-python.py");

function normalizeSql(value) {
  return value === null ? null : value.trim().split(/\s+/u).join(" ");
}

function schema(database) {
  return database
    .prepare("SELECT type,name,tbl_name AS 'table',sql FROM sqlite_master ORDER BY type,name")
    .all()
    .map((row) => ({ ...row, sql: normalizeSql(row.sql) }));
}

function commonUsage(usage, storage) {
  return {
    actual_cost_usd: usage.actualCostUsd,
    api_calls: usage.apiCallCount,
    estimated_cost_usd: usage.estimatedCostUsd,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    priced_call_count: usage.pricedCallCount,
    storage,
  };
}

function writeTs(path) {
  const connection = openStateDatabase(path);
  try {
    const repo = new SessionRepository(connection.database, () => 0, connection.ftsEnabled);
    repo.createSession({ id: "cross-parent", title: "parent", startedAt: 10 });
    repo.createSession({
      id: "cross",
      parentSessionId: "cross-parent",
      model: "stub-model",
      startedAt: 20,
    });
    repo.appendMessage("cross", { role: "user", content: "hello cross state", createdAt: 31 });
    repo.appendMessage("cross", {
      role: "assistant",
      content: null,
      finishReason: "tool_calls",
      createdAt: 32,
      toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a": 1}' } }],
      providerData: { z: 2, a: 1 },
    });
    repo.addUsage("cross", {
      inputTokens: 12,
      outputTokens: 8,
      apiCalls: 3,
      realUsd: 0,
      grossUsd: 0.5,
    });
  } finally {
    connection.close();
  }
}

function readTs(path) {
  const connection = openStateDatabase(path);
  try {
    const repo = new SessionRepository(connection.database, () => 0, connection.ftsEnabled);
    const stored = connection.database
      .prepare(
        "SELECT tool_calls,reasoning_details,typeof(actual_cost_usd) storage " +
          "FROM messages JOIN sessions ON sessions.id=messages.session_id " +
          "WHERE messages.role='assistant'",
      )
      .get();
    return {
      lineage: repo.lineageRootToTip("cross"),
      list: repo.listSessions({ limit: 10 }).map((row) => row.id),
      messages: repo.loadMessages("cross"),
      schema: schema(connection.database),
      search: repo.searchMessages("hello cross"),
      storedProviderData: stored.reasoning_details,
      storedToolCalls: stored.tool_calls,
      usage: commonUsage(repo.usage("cross"), stored.storage),
    };
  } finally {
    connection.close();
  }
}

function main() {
  const workspace = parseWorkspace(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "lohra-parity-t03-cross-read-"));
  const scratch = join(root, "guard");
  mkdirSync(scratch, { recursive: true });
  let raw;
  let projection;
  try {
    const before = guardBefore(workspace, scratch);
    const pythonToTs = join(root, "python-to-ts", "state.db");
    const tsToPython = join(root, "ts-to-python", "state.db");
    const pythonEnvironment = cleanEnvironment(join(root, "python-home"), {
      LOHRA_HOME: join(root, "python-home", ".lohra"),
    });
    mkdirSync(pythonEnvironment.TMPDIR, { recursive: true });
    parseJsonOutput(
      runBounded(workspace.python, [pythonDriver, "write", pythonToTs], {
        cwd: root,
        environment: pythonEnvironment,
      }),
      "CROSS_READ_PYTHON_WRITE",
    );
    const pythonWrittenTsRead = readTs(pythonToTs);
    writeTs(tsToPython);
    const tsWrittenPythonRead = parseJsonOutput(
      runBounded(workspace.python, [pythonDriver, "read", tsToPython], {
        cwd: root,
        environment: pythonEnvironment,
      }),
      "CROSS_READ_PYTHON_READ",
    );
    const left = canonicalJson(pythonWrittenTsRead);
    const right = canonicalJson(tsWrittenPythonRead);
    if (left !== right) throw new Error("CROSS_READ_DIVERGENCE: Python and TS projections differ");
    if (!pythonWrittenTsRead.storedToolCalls.startsWith('[{"id": "c1", "type": "function"')) {
      throw new Error("CROSS_READ_JSON_TEXT: stored tool_calls lost Python separators");
    }
    if (
      pythonWrittenTsRead.usage.actual_cost_usd !== 0 ||
      pythonWrittenTsRead.usage.storage !== "real"
    ) {
      throw new Error("CROSS_READ_REAL: integral REAL storage class was not preserved");
    }
    const after = guardAfter(workspace, scratch);
    projection = {
      directions: {
        pythonToTypescript: pythonWrittenTsRead,
        typescriptToPython: tsWrittenPythonRead,
      },
      guard: { commit: after.commit, clean: after.porcelain === "" },
      matched: true,
    };
    raw = {
      commands: [
        [workspace.python, pythonDriver, "write", pythonToTs],
        ["in-process", "dist/state/index.js", "read", pythonToTs],
        ["in-process", "dist/state/index.js", "write", tsToPython],
        [workspace.python, pythonDriver, "read", tsToPython],
      ],
      guardBefore: before,
      guardAfter: after,
      paths: { pythonToTs, tsToPython },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const evidence = writeEvidence(
    projectRoot,
    "t03-cross-read",
    { ...raw, cleanup: true },
    projection,
  );
  process.stdout.write(
    `${JSON.stringify({ probe: "t03-cross-read", evidence: evidence.path, projectionSha256: evidence.sha })}\n`,
  );
}

main();
