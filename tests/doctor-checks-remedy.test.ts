import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../src/doctor/index.js";
import type { Check, DoctorPayload } from "../src/doctor/model.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lohra-doctor-remedy-"));
  temporaryDirectories.push(home);
  return home;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function check(payload: DoctorPayload, name: string): Check {
  const found = payload.checks.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

describe("doctor remedy for broken JSON files (issue #94)", () => {
  it("points at a JSON validator instead of python3 for a broken mcp.json", async () => {
    const home = isolatedHome();
    writeFileSync(join(home, "mcp.json"), "{ not json");
    const { output } = await runDoctor({
      json: true,
      environment: { LOHRA_HOME: home, HOME: home, PATH: "/usr/bin:/bin" },
      probeOllama: () => Promise.resolve(false),
    });
    const payload = JSON.parse(output) as DoctorPayload;
    const mcp = check(payload, "mcp.json");
    expect(mcp.remedy).toBe(
      `inspect it with a JSON validator, e.g. jq . ${join(home, "mcp.json")}`,
    );
    expect(mcp.remedy).not.toContain("python3");
    expect(mcp.remedy).not.toContain("json.tool");
  });

  it("points at a JSON validator instead of python3 for a broken workflow_policy.json", async () => {
    const home = isolatedHome();
    writeFileSync(join(home, "workflow_policy.json"), "{ not json");
    const { output } = await runDoctor({
      json: true,
      environment: { LOHRA_HOME: home, HOME: home, PATH: "/usr/bin:/bin" },
      probeOllama: () => Promise.resolve(false),
    });
    const payload = JSON.parse(output) as DoctorPayload;
    const policy = check(payload, "workflow_policy.json");
    const path = join(home, "workflow_policy.json");
    expect(policy.remedy).toBe(`inspect it with a JSON validator, e.g. jq . ${path}`);
    expect(policy.remedy).not.toContain("python3");
    expect(policy.remedy).not.toContain("json.tool");
  });
});
