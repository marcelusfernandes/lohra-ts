#!/usr/bin/env node
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runCli as runParityCli } from "../cli.js";
import {
  assertTcpPortsClosed,
  evidenceRoot,
  oracleBackend,
  oraclePython,
  root,
  runChat,
  runGuards,
  type ChatObservation,
  type McpConfig,
  type ScenarioResult,
  writeSuiteEvidence,
} from "./harness.js";
import {
  CROSS_SERVER_FIXTURE,
  ONE_SERVER,
  PINNED_CHILD_FIXTURE,
  PINNED_COLLISION_FIXTURE,
  oneToolFixture,
  type McpFixture,
} from "./fixtures.js";

const EXPECTED_CHILD_MCP = ["mcp_fix_echo", "mcp_fix_search_docs", "mcp_fix_weird_name"];
const EXPECTED_CHILD_BASE = ["read_file", "write_file", "terminal", "web_fetch", "web_search"];
const guards = runGuards();

function parent(observation: ChatObservation) {
  return observation.records.find((record) => record.role === "parent");
}

function child(observation: ChatObservation) {
  return observation.records.find((record) => record.role === "child");
}

function output(observation: ChatObservation): string {
  const value = observation.envelope?.["output"];
  return typeof value === "string" ? value : "";
}

function mcpNames(observation: ChatObservation): readonly string[] {
  return (parent(observation)?.toolNames ?? []).filter((name) => name.startsWith("mcp_"));
}

function exact(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function warningLines(observation: ChatObservation): readonly string[] {
  return observation.stderr.split("\n").filter(Boolean);
}

function servedBy(observation: ChatObservation): string | null {
  const match = output(observation).match(/served-by:([^:>]+):/u);
  return match?.[1] ?? null;
}

function normalizeConfigMessage(message: string): string {
  return message.replace(/could not parse .*?mcp\.json:/u, "could not parse <MCP_JSON>:");
}

function normalizeRaisedEnvelope(value: string): string {
  return value.replace(/Tool execution failed: [A-Za-z_.]+:/u, "Tool execution failed: <CLASS>:");
}

async function pair(
  tag: string,
  options: {
    readonly prompt?: string;
    readonly mcpConfig?: McpConfig;
    readonly fixture?: McpFixture;
    readonly toolName?: string;
  },
): Promise<{ readonly oracle: ChatObservation; readonly candidate: ChatObservation }> {
  const common = {
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.mcpConfig === undefined ? {} : { mcpConfig: options.mcpConfig }),
    ...(options.fixture === undefined ? {} : { fixture: options.fixture }),
    fake: options.toolName === undefined ? {} : { toolName: options.toolName },
  };
  const oracle = await runChat("oracle", { tag: `${tag}-oracle`, ...common });
  const candidate = await runChat("candidate", { tag: `${tag}-candidate`, ...common });
  return { oracle, candidate };
}

async function scenario(
  id: string,
  assertions: readonly (number | string)[],
  body: () =>
    | Promise<Omit<ScenarioResult, "id" | "assertions" | "tier">>
    | Omit<ScenarioResult, "id" | "assertions" | "tier">,
  tier = "chat-bilateral",
): Promise<ScenarioResult> {
  try {
    await assertTcpPortsClosed();
    return { id, assertions, tier, ...(await body()) };
  } catch (error) {
    return {
      id,
      assertions,
      tier,
      pass: false,
      projection: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function runT09Manifest(id: string): {
  readonly code: number;
  readonly evidence: Record<string, unknown>;
} {
  const manifest = resolve(root, `scripts/parity/manifests/t09/${id}.json`);
  const evidencePath = resolve(evidenceRoot, `${id}.json`);
  rmSync(evidencePath, { force: true });
  const code = runParityCli(["--manifest", manifest, "--evidence", evidencePath]);
  return {
    code,
    evidence: JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>,
  };
}

function runR1Probe(side: "oracle" | "candidate"): Readonly<Record<string, unknown>> {
  const result =
    side === "oracle"
      ? spawnSync(oraclePython, [resolve(root, "scripts/parity/mcp/oracle-r1-probe.py")], {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: `${resolve(oraclePython, "..")}:/usr/bin:/bin`,
            PYTHONPATH: oracleBackend,
            PYTHONDONTWRITEBYTECODE: "1",
          },
        })
      : spawnSync(process.execPath, [resolve(root, "scripts/parity/mcp/r1-probe.mjs")], {
          cwd: root,
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });
  if (result.status !== 0) throw new Error(`T19_R1_PROBE_${side}:${result.stderr}`);
  return JSON.parse(result.stdout) as Readonly<Record<string, unknown>>;
}

const results: ScenarioResult[] = [];

results.push(
  await scenario("t19-child-with-mcp-8-tools", [6, 7, 8], async () => {
    const config = { mcpServers: { fix: { command: "/bin/echo" } } };
    const observed = await pair("child-with-mcp", {
      prompt: "SCEN:delegate go",
      mcpConfig: config,
      fixture: PINNED_CHILD_FIXTURE,
    });
    const oracleParent = parent(observed.oracle)?.toolNames ?? [];
    const oracleChild = child(observed.oracle)?.toolNames ?? [];
    const candidateParent = parent(observed.candidate)?.toolNames ?? [];
    const candidateChild = child(observed.candidate)?.toolNames ?? [];
    const oracleOk =
      oracleParent.length === 27 &&
      oracleChild.length === 8 &&
      exact(oracleChild, [...EXPECTED_CHILD_BASE, ...EXPECTED_CHILD_MCP]);
    const candidateOk = exact(candidateChild, oracleChild) && exact(candidateParent, oracleParent);
    return {
      pass: oracleOk && candidateOk,
      projection: {
        fixtureShaInput: PINNED_CHILD_FIXTURE,
        oracle: { parent: oracleParent, child: oracleChild, exitCode: observed.oracle.exitCode },
        candidate: {
          parent: candidateParent,
          child: candidateChild,
          exitCode: observed.candidate.exitCode,
          output: output(observed.candidate),
        },
        deferredIntegrationDependency: !candidateOk,
      },
      note: candidateOk
        ? "T13 integration present; public bilateral child turn exercised."
        : "BLOCKING/DEFERRED: oracle exercised; candidate f6a5f51 has only the delegate_task fail-safe. Process-level substitution is prohibited; requires an approved T13 integration SHA.",
    };
  }),
);

results.push(
  await scenario("t19-child-unknown-hardening-reverdicted", [9], () => {
    const observed = runT09Manifest("t09-child-unknown-hardening");
    const verdict = observed.evidence["verdict"];
    return {
      pass: observed.code === 0 && verdict === "match",
      projection: { code: observed.code, verdict },
      note: "Reexecutes the approved T09 bilateral scenario under R1's versioned verdict map.",
    };
  }),
);

results.push(
  await scenario("t19-child-terminal-type-hardening-unchanged", [10], () => {
    const observed = runT09Manifest("t09-child-terminal-type-hardening");
    const verdict = observed.evidence["verdict"];
    return {
      pass: observed.code === 1 && verdict === "divergent",
      projection: { code: observed.code, verdict },
      note: "The non-string command hardening remains the sole expected divergence; the 19 exclusions remain matches.",
    };
  }),
);

results.push(
  await scenario(
    "t19-subset-relation-real-p",
    [11],
    () => {
      const oracle = runR1Probe("oracle");
      const candidate = runR1Probe("candidate");
      const keys = [
        "removedEqualsExcludedIntersection",
        "AIntersectEIsEmpty",
        "AIntersectPSubsetOfPMinusE",
      ];
      return {
        pass:
          keys.every((key) => oracle[key] === true && candidate[key] === true) &&
          exact(oracle["child"], candidate["child"]),
        projection: { oracle, candidate },
        note: "Interim bilateral process proof over the pinned real-P catalog; does not substitute for scenario 1's deferred public traversal.",
      };
    },
    "process-bilateral-supporting",
  ),
);

results.push(
  await scenario("t19-cross-server-shadow-last-wins", [12, 13], async () => {
    const orders = [
      ["github.com", "github_com"],
      ["github_com", "github.com"],
    ] as const;
    const projections = [];
    let pass = true;
    for (const order of orders) {
      const mcpServers = Object.fromEntries(order.map((name) => [name, { command: "/bin/echo" }]));
      const observed = await pair(`shadow-${order.join("-")}`, {
        prompt: "SCEN:mcpcall go",
        mcpConfig: { mcpServers },
        fixture: CROSS_SERVER_FIXTURE,
        toolName: "mcp_github_com_search",
      });
      const expectedOwner = order[1];
      const oracleProjection = {
        names: mcpNames(observed.oracle),
        owner: servedBy(observed.oracle),
        warnings: warningLines(observed.oracle),
      };
      const candidateProjection = {
        names: mcpNames(observed.candidate),
        owner: servedBy(observed.candidate),
        warnings: warningLines(observed.candidate),
      };
      pass &&=
        exact(oracleProjection, candidateProjection) &&
        exact(oracleProjection.names, ["mcp_github_com_search"]) &&
        oracleProjection.owner === expectedOwner &&
        oracleProjection.warnings.length === 0;
      projections.push({
        order,
        expectedOwner,
        oracle: oracleProjection,
        candidate: candidateProjection,
      });
    }
    return { pass, projection: projections };
  }),
);

results.push(
  await scenario("t19-intra-server-collision-warns", [14, 26], async () => {
    const observed = await pair("intra-collision", {
      mcpConfig: ONE_SERVER,
      fixture: PINNED_COLLISION_FIXTURE,
    });
    const expected =
      "MCP tool 'fix'/'do thing' collides with an earlier tool as 'mcp_fix_do_thing' — skipped";
    const oracleProjection = {
      names: mcpNames(observed.oracle),
      total: parent(observed.oracle)?.toolNames.length,
      warnings: warningLines(observed.oracle),
    };
    const candidateProjection = {
      names: mcpNames(observed.candidate),
      total: parent(observed.candidate)?.toolNames.length,
      warnings: warningLines(observed.candidate),
    };
    return {
      pass:
        exact(oracleProjection, candidateProjection) &&
        exact(oracleProjection.names, ["mcp_fix_do_thing", "mcp_fix_other"]) &&
        oracleProjection.total === 26 &&
        exact(oracleProjection.warnings, [expected]),
      projection: { fixture: PINNED_COLLISION_FIXTURE, oracleProjection, candidateProjection },
    };
  }),
);

const configCases: readonly {
  readonly name: string;
  readonly config: McpConfig | undefined;
  readonly expected: string;
}[] = [
  { name: "malformed", config: "{not json", expected: "could not parse <MCP_JSON>:" },
  { name: "root-array", config: [], expected: "'mcpServers' must be an object" },
  { name: "servers-array", config: { mcpServers: [] }, expected: "'mcpServers' must be an object" },
  {
    name: "missing-transport",
    config: { mcpServers: { bad: { foo: 1 } } },
    expected: "server 'bad' needs a 'command' (stdio) or 'url' (http)",
  },
  {
    name: "server-not-object",
    config: { mcpServers: { bad: "nope" } },
    expected: "server 'bad' must be an object",
  },
  { name: "absent", config: undefined, expected: "" },
  { name: "empty", config: { mcpServers: {} }, expected: "" },
  {
    name: "disabled",
    config: { mcpServers: { fix: { command: "/bin/echo", disabled: true } } },
    expected: "",
  },
  {
    name: "disabled-number-truthy",
    config: { mcpServers: { fix: { command: "/bin/echo", disabled: 1 } } },
    expected: "",
  },
  {
    name: "disabled-string-truthy",
    config: { mcpServers: { fix: { command: "/bin/echo", disabled: "yes" } } },
    expected: "",
  },
  {
    name: "disabled-misleading-string-truthy",
    config: { mcpServers: { fix: { command: "/bin/echo", disabled: "false" } } },
    expected: "",
  },
];

results.push(
  await scenario("t19-config-negative-goldens", [20, 21], async () => {
    const projections = [];
    let pass = true;
    for (const item of configCases) {
      const observed = await pair(
        `config-${item.name}`,
        item.config === undefined ? {} : { mcpConfig: item.config },
      );
      const oracleMessage = normalizeConfigMessage(observed.oracle.stderr);
      const candidateMessage = normalizeConfigMessage(observed.candidate.stderr);
      const expectedMatch =
        item.expected === "could not parse <MCP_JSON>:"
          ? oracleMessage.startsWith(`ignoring MCP config: ${item.expected}`) &&
            candidateMessage.startsWith(`ignoring MCP config: ${item.expected}`)
          : oracleMessage === (item.expected ? `ignoring MCP config: ${item.expected}\n` : "") &&
            candidateMessage === oracleMessage;
      pass &&=
        expectedMatch &&
        observed.oracle.exitCode === 0 &&
        observed.candidate.exitCode === 0 &&
        mcpNames(observed.oracle).length === 0 &&
        mcpNames(observed.candidate).length === 0;
      projections.push({
        name: item.name,
        oracle: oracleMessage,
        candidate: candidateMessage,
        malformedRuntimeTextExcused: item.name === "malformed",
      });
    }
    const abortConfig = {
      mcpServers: { good: { command: "/bin/echo" }, bad: { nope: true } },
    };
    const aborted = await pair("config-aborts-set", {
      mcpConfig: abortConfig,
      fixture: { servers: { good: { tools: [{ name: "ok" }] } } },
    });
    pass &&= mcpNames(aborted.oracle).length === 0 && mcpNames(aborted.candidate).length === 0;
    return {
      pass,
      projection: {
        cases: projections,
        abortsWholeSet: {
          oracleMcp: mcpNames(aborted.oracle),
          candidateMcp: mcpNames(aborted.candidate),
        },
      },
    };
  }),
);

results.push(
  await scenario("t19-naming-sanitization", [22], async () => {
    const fixture: McpFixture = {
      servers: {
        "My Server!": {
          tools: [
            { name: "Weird-Name!", description: "d", inputSchema: { type: "object" } },
            { name: "", description: "ignored", inputSchema: { type: "object" } },
          ],
        },
      },
    };
    const observed = await pair("naming", {
      mcpConfig: { mcpServers: { "My Server!": { command: "/bin/echo" } } },
      fixture,
    });
    return {
      pass:
        exact(mcpNames(observed.oracle), ["mcp_my_server_weird_name"]) &&
        exact(mcpNames(observed.oracle), mcpNames(observed.candidate)) &&
        warningLines(observed.oracle).length === 0 &&
        warningLines(observed.candidate).length === 0,
      projection: {
        oracle: mcpNames(observed.oracle),
        candidate: mcpNames(observed.candidate),
        rawToolsetProof: "t19-shadow-deregister-orphan",
      },
    };
  }),
);

results.push(
  await scenario("t19-schema-coercions", [23], async () => {
    const fixture: McpFixture = {
      servers: {
        fix: {
          tools: [
            {
              name: "good",
              description: "a good one",
              inputSchema: {
                type: "object",
                properties: { q: { type: "string" } },
                required: ["q"],
              },
            },
            { name: "schema_is_string", description: "bad schema", inputSchema: "nope" },
            { name: "schema_missing", description: "no schema at all" },
            {
              name: "desc_null",
              description: null,
              inputSchema: { type: "object", properties: {} },
            },
            { name: "", description: "empty name", inputSchema: { type: "object" } },
          ],
        },
      },
    };
    const observed = await pair("schema", { mcpConfig: ONE_SERVER, fixture });
    const project = (side: ChatObservation) =>
      (parent(side)?.definitions ?? [])
        .map((entry) => (entry as Record<string, unknown>)["function"] as Record<string, unknown>)
        .filter((fn) => typeof fn["name"] === "string" && fn["name"].startsWith("mcp_"))
        .map((fn) => ({ keys: Object.keys(fn), value: fn }));
    const oracleProjection = project(observed.oracle);
    const candidateProjection = project(observed.candidate);
    return {
      pass:
        exact(oracleProjection, candidateProjection) &&
        oracleProjection.length === 4 &&
        oracleProjection.every((entry) => exact(entry.keys, ["description", "parameters", "name"])),
      projection: { oracle: oracleProjection, candidate: candidateProjection },
    };
  }),
);

results.push(
  await scenario("t19-result-envelopes-five-shapes", [24], async () => {
    const cases = [
      {
        name: "text",
        fixture: oneToolFixture({
          call_results: {
            echo: {
              content: [
                { type: "text", text: "part-one " },
                { type: "text", text: "part-two" },
              ],
              isError: false,
            },
          },
        }),
        toolName: "mcp_fix_echo",
      },
      {
        name: "non-text",
        fixture: oneToolFixture({
          call_results: { echo: { content: [{ type: "image", data: "xxx" }], isError: false } },
        }),
        toolName: "mcp_fix_echo",
      },
      {
        name: "is-error",
        fixture: oneToolFixture({
          call_results: {
            echo: { content: [{ type: "text", text: "boom from server" }], isError: true },
          },
        }),
        toolName: "mcp_fix_echo",
      },
      {
        name: "is-error-empty",
        fixture: oneToolFixture({ call_results: { echo: { content: [], isError: true } } }),
        toolName: "mcp_fix_echo",
      },
      { name: "unknown", fixture: oneToolFixture(), toolName: "mcp_missing_tool" },
      {
        name: "raises",
        fixture: oneToolFixture({ call_raises: "MCP transport exploded" }),
        toolName: "mcp_fix_echo",
      },
    ] as const;
    const projections = [];
    let pass = true;
    for (const item of cases) {
      const observed = await pair(`envelope-${item.name}`, {
        prompt: "SCEN:mcpcall go",
        mcpConfig: ONE_SERVER,
        fixture: item.fixture,
        toolName: item.toolName,
      });
      const oracleOutput =
        item.name === "raises"
          ? normalizeRaisedEnvelope(output(observed.oracle))
          : output(observed.oracle);
      const candidateOutput =
        item.name === "raises"
          ? normalizeRaisedEnvelope(output(observed.candidate))
          : output(observed.candidate);
      pass &&=
        oracleOutput === candidateOutput &&
        observed.oracle.exitCode === 0 &&
        observed.candidate.exitCode === 0;
      projections.push({ name: item.name, oracle: oracleOutput, candidate: candidateOutput });
    }
    return { pass, projection: projections };
  }),
);

results.push(
  await scenario("t19-connect-vs-list-tools-same-message", [21, 25], async () => {
    const config = {
      mcpServers: { bad: { command: "/bin/echo" }, good: { command: "/bin/echo" } },
    };
    const good = {
      tools: [{ name: "ok", description: "d", inputSchema: { type: "object", properties: {} } }],
    };
    const variants: readonly [string, McpFixture][] = [
      ["connect", { servers: { bad: { connect_raises: "same cause" }, good } }],
      ["list", { servers: { bad: { list_tools_raises: "same cause" }, good } }],
    ];
    const projections = [];
    let pass = true;
    for (const [name, fixture] of variants) {
      const observed = await pair(`failure-${name}`, { mcpConfig: config, fixture });
      const oracleProjection = { stderr: observed.oracle.stderr, names: mcpNames(observed.oracle) };
      const candidateProjection = {
        stderr: observed.candidate.stderr,
        names: mcpNames(observed.candidate),
      };
      pass &&=
        exact(oracleProjection, candidateProjection) &&
        oracleProjection.stderr === "MCP server 'bad' failed to connect: same cause\n" &&
        exact(oracleProjection.names, ["mcp_good_ok"]);
      projections.push({ name, oracle: oracleProjection, candidate: candidateProjection });
    }
    return { pass, projection: projections };
  }),
);

results.push(
  await scenario("t19-warnings-bare-stderr", [26], async () => {
    const observed = await pair("bare-warning", {
      mcpConfig: ONE_SERVER,
      fixture: PINNED_COLLISION_FIXTURE,
    });
    const oracleWarnings = warningLines(observed.oracle);
    const candidateWarnings = warningLines(observed.candidate);
    const noPrefix = (line: string) =>
      !/^(WARNING|WARN|ERROR|INFO)(:|\s)/u.test(line) && !line.includes("lohra.mcp");
    return {
      pass:
        exact(oracleWarnings, candidateWarnings) &&
        oracleWarnings.length === 1 &&
        oracleWarnings.every(noPrefix) &&
        candidateWarnings.every(noPrefix),
      projection: { oracleWarnings, candidateWarnings },
    };
  }),
);

const evidence = writeSuiteEvidence("t19-chat-bilateral", guards, results);
process.stdout.write(
  `${JSON.stringify({
    suite: evidence["suite"],
    scenarios: evidence["scenarios"],
    failures: evidence["failures"],
    digest: evidence["digest"],
    blocked: results
      .filter((result) => result.note?.startsWith("BLOCKING"))
      .map((result) => result.id),
  })}\n`,
);
process.exitCode = results.every((result) => result.pass) ? 0 : 1;
