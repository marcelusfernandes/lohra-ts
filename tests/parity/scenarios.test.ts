import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseScenarioManifest } from "../../scripts/parity/manifest.js";

const scenarios = [
  "oracle-version",
  "oracle-no-subcommand",
  "oracle-workflow-list",
  "events-jsonl-fixture",
  "deliberate-divergence",
];

const sprint02Scenarios = [
  "ts-version",
  "ts-no-subcommand",
  "ts-help",
  "ts-doctor-down",
  "ts-doctor-text-down",
  "ts-doctor-env-file",
  "ts-doctor-env-sources",
  "ts-doctor-profile",
  "ts-doctor-invalid-profile",
  "ts-doctor-unicode-profile",
  "ts-doctor-invalid-order",
  "ts-doctor-home-override",
  "ts-doctor-env-profile",
  "normalization-replace-text",
  "normalization-replace-json-pointer",
  "serializer-json-stringify-divergence",
] as const;

const sprint03Scenarios = [
  "t02-doctor-down",
  "t02-doctor-up",
  "t02-doctor-empty-models",
  "t02-chat-auto-json",
  "t02-chat-auto-empty-models",
  "t02-chat-json-no-tools",
  "t02-chat-stream",
  "t02-chat-stream-nodone",
  "t02-chat-stream-options-retry",
  "t02-chat-tool-read-file-json",
  "t02-chat-tool-read-file-stream",
  "t02-chat-tool-unknown",
  "t02-chat-http-401",
  "t02-chat-http-500",
  "t02-chat-auto-down",
  "t02-chat-explicit-down",
  "t02-chat-provider-without-model-up",
  "t02-deliberate-divergence",
] as const;

describe("versioned scenarios", () => {
  it.each(scenarios)("parses %s without an author-local absolute path", (name) => {
    const path = resolve(`scripts/parity/scenarios/${name}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain(".oracle-venv/bin/lohra");
    expect(parseScenarioManifest(JSON.parse(source) as unknown).id).toBe(name);
  });

  it("declares the volatile SQLite shm exclusion only in workflow capture policy", () => {
    const source = JSON.parse(
      readFileSync(resolve("scripts/parity/scenarios/oracle-workflow-list.json"), "utf8"),
    ) as { capture: { tree: { exclude: string[] } } };
    expect(source.capture.tree.exclude).toEqual([".lohra/state.db-shm"]);
  });

  it.each(sprint02Scenarios)("parses Sprint 02 scenario %s portably", (name) => {
    const path = resolve(`scripts/parity/scenarios/${name}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("/Users/");
    expect(parseScenarioManifest(JSON.parse(source) as unknown).id).toBe(name);
  });

  it.each(sprint02Scenarios)("fixes COLUMNS=80 in Sprint 02 scenario %s", (name) => {
    const source = JSON.parse(
      readFileSync(resolve(`scripts/parity/scenarios/${name}.json`), "utf8"),
    ) as { environment: { set: Record<string, string> } };
    expect(source.environment.set.COLUMNS).toBe("80");
  });

  it("declares the stub-down port precondition on every doctor scenario", () => {
    for (const name of sprint02Scenarios.filter((scenario) => scenario.includes("doctor"))) {
      const source = JSON.parse(
        readFileSync(resolve(`scripts/parity/scenarios/${name}.json`), "utf8"),
      ) as { preconditions: unknown[] };
      expect(source.preconditions).toEqual([
        { kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 },
      ]);
    }
  });

  it("exercises both formerly unit-only normalizers in versioned scenarios", () => {
    const text = JSON.parse(
      readFileSync(resolve("scripts/parity/scenarios/normalization-replace-text.json"), "utf8"),
    ) as { normalizations: Array<{ kind: string }> };
    const pointer = JSON.parse(
      readFileSync(
        resolve("scripts/parity/scenarios/normalization-replace-json-pointer.json"),
        "utf8",
      ),
    ) as { normalizations: Array<{ kind: string }> };

    expect(text.normalizations.map(({ kind }) => kind)).toContain("replace-text");
    expect(pointer.normalizations.map(({ kind }) => kind)).toContain("replace-json-pointer");
  });

  it.each(sprint03Scenarios)("parses Sprint 03 scenario %s with explicit stub policy", (name) => {
    const path = resolve(`scripts/parity/scenarios/${name}.json`);
    const source = readFileSync(path, "utf8");
    const manifest = parseScenarioManifest(JSON.parse(source) as unknown);

    expect(source).not.toContain("/Users/");
    expect(manifest.id).toBe(name);
    expect(manifest.stub).toBeDefined();
    expect(manifest.preconditions).toEqual([
      { kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 },
    ]);
    expect(
      manifest.capture.events.find(({ name: event }) => event === "requestsRaw"),
    ).toMatchObject({ projection: "raw-only" });
  });
});
