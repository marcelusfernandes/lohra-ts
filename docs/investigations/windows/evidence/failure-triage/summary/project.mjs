// #754: projeção auditável do inventário #751. Sem execução de testes/produto.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./", import.meta.url));
const inventory = fileURLToPath(new URL("../inventory/", import.meta.url));
const platform = fileURLToPath(new URL("../platform/mapping.json", import.meta.url));
const rows = (name) =>
  readFileSync(inventory + name, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
const failures = new Map([
  ["20", rows("failures-node20.jsonl")],
  ["22", rows("failures-node22.jsonl")],
]);
const diagnostics = new Map([
  ["20", rows("stderr-node20.jsonl")],
  ["22", rows("stderr-node22.jsonl")],
]);
const fileResults = rows("files.jsonl");
const platformIds = JSON.parse(readFileSync(platform, "utf8"));
const modes = new Set(platformIds.node20.modePosixIds);
const signals = new Set(platformIds.node20.signalHarnessIds);
const shellFiles = new Set([
  "tests/protege-main.test.ts",
  "tests/stop-gate.test.ts",
  "tests/claude-skills-scripts.test.ts",
  "tests/protege-escrita.test.ts",
]);
const known = {
  "negative-npm": { status: "confirmed", issue: 802, next: null },
  "serve-child-kill": { status: "confirmed", issue: 804, next: null },
  "sqlite-session-fixture": { status: "confirmed", issue: 806, next: null },
};
const hypothesisIssue = (family) => {
  if (family === "state-path-unresolved" || family === "line-ending:tests/gateway/tools.test.ts") {
    return 809;
  }
  if (family === "stub-driver-unresolved") return 810;
  if (family === "sqlite-unresolved:tests/workflow-leaf-read-tool.test.ts") return 811;
  if (family.startsWith("unresolved:") && shellFiles.has(family.slice("unresolved:".length))) {
    return 812;
  }
  if (
    family === "sqlite-unresolved:tests/gateway/rpc-dispatch.test.ts" ||
    family === "sqlite-unresolved:tests/gateway/raw-socket-primitives.test.ts"
  ) {
    return 813;
  }
  if (family === "sqlite-unresolved:tests/gateway/prompt-submit.test.ts") return 814;
  if (family === "npm-pack-unresolved") return 815;
  if (family === "unresolved:tests/self-update.test.ts") return 816;
  return null;
};

function classify(row) {
  const { file, id, message, fileOperation } = row;
  if (
    file === "tests/ci-controle-negativo-integracao.test.ts" ||
    file === "tests/ci-controle-negativo-lacunas.test.ts"
  ) {
    return "negative-npm";
  }
  if (file === "tests/cli-serve-process.test.ts") return "serve-child-kill";
  if (file === "tests/gateway/session-service.test.ts") return "sqlite-session-fixture";
  if (modes.has(id)) return "posix-mode-observed";
  if (signals.has(id)) return "signal-harness-unresolved";
  if (fileOperation?.operation === "unlink" && fileOperation.targetBasename === "state.db") {
    return `sqlite-unresolved:${file}`;
  }
  if (file === "tests/package-manifest.test.ts") return "npm-pack-unresolved";
  if (file === "tests/parity/stub-driver.test.ts") return "stub-driver-unresolved";
  if (file === "tests/state-schema.test.ts") return "state-path-unresolved";
  if (message.includes("\\r\\n") || message.includes("\\r")) return `line-ending:${file}`;
  return `unresolved:${file}`;
}

function nextExperiment(family, file) {
  if (family === "posix-mode-observed") return "acl-two-identities";
  if (family === "signal-harness-unresolved") return "child-handler-vs-runner";
  if (family.startsWith("sqlite-unresolved:")) return "fixture-open-close";
  if (family === "npm-pack-unresolved") return "spawn-error-and-status";
  if (family === "unresolved:tests/self-update.test.ts") return "runner-spawn-error";
  if (family === "stub-driver-unresolved") return "url-path-vs-fileurltopath";
  if (family === "state-path-unresolved") return "windows-home-path-contract";
  if (family.startsWith("line-ending:")) return "raw-output-eol-control";
  if (shellFiles.has(file)) return "sh-explicit-path-control";
  return `focal-isolated:${file}`;
}

const byNode = new Map();
for (const [node, nodeRows] of failures) {
  const map = new Map();
  for (const row of nodeRows) {
    if (map.has(row.id)) throw new Error(`duplicate ID within Node ${node}: ${row.id}`);
    map.set(row.id, row);
  }
  byNode.set(node, map);
}
const ids = [...new Set([...byNode.get("20").keys(), ...byNode.get("22").keys()])].sort();
const assignments = ids.map((id) => {
  const present = [...byNode].filter(([, map]) => map.has(id)).map(([node]) => node);
  const nodeRows = present.map((node) => byNode.get(node).get(id));
  const files = new Set(nodeRows.map((row) => row.file));
  if (files.size !== 1) throw new Error(`ID maps to different files: ${id}`);
  const families = new Set(nodeRows.map(classify));
  if (families.size !== 1) throw new Error(`ID maps to different families: ${id}`);
  const family = [...families][0];
  const file = nodeRows[0].file;
  const meta = known[family] ?? {
    status: "INCONCLUSIVE",
    issue: hypothesisIssue(family),
    next: nextExperiment(family, file),
  };
  return { id, nodes: present, file, family, ...meta };
});
const secondary = [...failures].flatMap(([node, nodeRows]) =>
  nodeRows.flatMap((row) =>
    row.secondary.map((item) => ({
      id: row.id,
      node,
      order: item.order,
      primaryFamily: classify(row),
      secondaryOperation: item.fileOperation?.operation ?? null,
      secondaryTarget: item.fileOperation?.targetBasename ?? null,
      causalRelation: "NOT_DEMONSTRATED",
    })),
  ),
);
const stderr = [...diagnostics].flatMap(([node, nodeRows]) =>
  nodeRows.map((item) => ({
    node,
    order: item.order,
    family: item.message.includes("ELOOP") ? "path-eloop" : "mcp-shadowing",
    attribution: "UNATTRIBUTED_DIAGNOSTIC",
    next: item.message.includes("ELOOP") ? "isolated-skill-path" : "isolated-mcp-registry",
  })),
);
function countBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = item[key];
    groups.set(value, (groups.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)));
}
const reconciliation = {
  inventorySha: "ebeb722f898bdb4cde5b7d7cef66fb40febf5c15",
  assertions: Object.fromEntries([...failures].map(([node, nodeRows]) => [node, nodeRows.length])),
  fileResults: fileResults.length,
  failedFiles: Object.fromEntries(
    [...failures].map(([node]) => [
      node,
      fileResults.filter((item) => item[`node${node}`].status === "failed").length,
    ]),
  ),
  uniqueIds: ids.length,
  sharedIds: assignments.filter((item) => item.nodes.length === 2).length,
  onlyNode20: assignments.filter((item) => item.nodes.length === 1 && item.nodes[0] === "20")
    .length,
  onlyNode22: assignments.filter((item) => item.nodes.length === 1 && item.nodes[0] === "22")
    .length,
  secondary: Object.fromEntries(
    [...failures].map(([node]) => [node, secondary.filter((item) => item.node === node).length]),
  ),
  stderr: Object.fromEntries([...diagnostics].map(([node, nodeRows]) => [node, nodeRows.length])),
  byStatus: countBy(assignments, "status"),
  byNodeStatus: Object.fromEntries(
    [...failures].map(([node]) => [
      node,
      countBy(
        assignments.filter((item) => item.nodes.includes(node)),
        "status",
      ),
    ]),
  ),
  byFamily: countBy(assignments, "family"),
};
if (
  reconciliation.assertions["20"] !== 229 ||
  reconciliation.assertions["22"] !== 232 ||
  reconciliation.fileResults !== 336 ||
  reconciliation.failedFiles["20"] !== 54 ||
  reconciliation.failedFiles["22"] !== 54 ||
  reconciliation.uniqueIds !== 232 ||
  reconciliation.sharedIds !== 229 ||
  reconciliation.onlyNode20 !== 0 ||
  reconciliation.onlyNode22 !== 3 ||
  reconciliation.secondary["20"] !== 17 ||
  reconciliation.secondary["22"] !== 17 ||
  reconciliation.stderr["20"] !== 7 ||
  reconciliation.stderr["22"] !== 7
) {
  throw new Error("inventory reconciliation changed");
}
for (const [node, nodeRows] of failures) {
  const filesWithAssertions = new Set(nodeRows.map((item) => item.file));
  for (const item of fileResults) {
    if (item[`node${node}`].status === "failed" && !filesWithAssertions.has(item.file)) {
      throw new Error(`unattributed failed file in Node ${node}: ${item.file}`);
    }
  }
}
const jsonl = (items) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";
const artifacts = new Map([
  ["assignments.jsonl", jsonl(assignments)],
  ["secondary.jsonl", jsonl(secondary)],
  ["stderr.jsonl", jsonl(stderr)],
  ["reconciliation.json", JSON.stringify(reconciliation, null, 2) + "\n"],
]);
const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("use --write or --check");
for (const [name, content] of artifacts) {
  if (mode === "--write") writeFileSync(directory + name, content);
  else if (readFileSync(directory + name, "utf8") !== content) {
    throw new Error(`stale artifact: ${name}`);
  }
}
console.log(JSON.stringify({ ok: true, mode, ...reconciliation }));
