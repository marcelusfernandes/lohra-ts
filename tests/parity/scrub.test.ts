import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertCredentialClean } from "../../scripts/parity/scrub.js";
import type { EvidenceRecord, FixtureSpec } from "../../scripts/parity/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const evidence = (stdout: string): EvidenceRecord => ({
  schemaVersion: 1,
  scenario: { id: "scrub-test", manifestSha256: "fixture" },
  commands: {
    oracle: { executable: "fixture", argv: [] },
    candidate: { executable: "fixture", argv: [] },
  },
  capturePolicy: { tree: { enabled: false, root: "home", exclude: [] }, sqlite: [], events: [] },
  expectationPolicy: [],
  normalizationPolicy: [],
  preconditionPolicy: [],
  preconditions: [],
  runs: {
    oracle: {
      process: {
        exitCode: 0,
        signal: null,
        stdout: Buffer.from(stdout).toString("base64"),
        stderr: "",
      },
      tree: [],
      sqlite: {},
      events: {},
    },
    candidate: {
      process: { exitCode: 0, signal: null, stdout: "", stderr: "" },
      tree: [],
      sqlite: {},
      events: {},
    },
  },
  comparison: { verdict: "match", differences: [], normalized: {} },
  expectations: { failures: [] },
  reproducibility: { excludedRawPointers: [], projectionSha256: "fixture" },
  verdict: "match",
});

describe("credential evidence scrub", () => {
  it("detects a fixture token in a base64-encoded process stream", () => {
    const fixture: FixtureSpec = {
      root: "profile",
      path: "oauth.json",
      encoding: "utf8",
      content: '{"access_token":"FIXTURE-TOKEN-T05"}',
    };
    const record = evidence("leak FIXTURE-TOKEN-T05");
    expect(() => {
      assertCredentialClean(
        JSON.stringify(record),
        record,
        [fixture],
        { fixtureTokens: true, operatorCredentials: false },
        "/unused",
      );
    }).toThrow(expect.objectContaining({ code: "CREDENTIAL_LEAK" }));
  });

  it("detects an operator account id decoded from a JWT without exposing it", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-scrub-test-"));
    roots.push(root);
    mkdirSync(join(root, ".codex"), { recursive: true });
    const account = "OPERATOR-ACCOUNT-T05-HIGH-ENTROPY";
    const payload = Buffer.from(`{"chatgpt_account_id":"${account}"}`).toString("base64url");
    writeFileSync(
      join(root, ".codex", "auth.json"),
      `{"tokens":{"access_token":"x.${payload}.x"}}`,
    );
    const record = evidence(account);
    expect(() => {
      assertCredentialClean(
        JSON.stringify(record),
        record,
        [],
        { fixtureTokens: false, operatorCredentials: true },
        root,
      );
    }).toThrow(expect.objectContaining({ code: "CREDENTIAL_LEAK" }));
  });

  it("ignores short operator values and schema names", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-scrub-test-"));
    roots.push(root);
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "auth.json"),
      '{"access_token":"short","subscription":"openai-codex"}',
    );
    const record = evidence("OPENAI_API_KEY access_token subscription openai-codex short");
    expect(() => {
      assertCredentialClean(
        JSON.stringify(record),
        record,
        [],
        { fixtureTokens: false, operatorCredentials: true },
        root,
      );
    }).not.toThrow();
  });
});
