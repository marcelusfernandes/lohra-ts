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
    expect(mcp.detail).toBe(`${join(home, "mcp.json")} — invalid JSON`);
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
    expect(policy.detail).toBe(`${path} — invalid JSON`);
  });
});

describe("doctor remedy text no longer names a Python exception (issue #97)", () => {
  it("reports 'invalid JSON' for a malformed catalog HTTP response", async () => {
    const { fetchModels } = await import("../src/catalog/catalog.js");
    const { getProviderProfile } = await import("../src/providers/registry.js");
    const profile = getProviderProfile("openai");
    if (profile === null) throw new Error("missing test profile: openai");
    const malformed = {
      get: () => Promise.resolve({ status: 200, body: new TextEncoder().encode("{ not json") }),
    };
    const result = await fetchModels(profile, "x", malformed);
    expect(result.detail).toBe("invalid JSON");
  });

  it("reports 'invalid JSON' for a malformed ollama probe response", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{ not json");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no server address");
    const url = `http://127.0.0.1:${String(address.port)}/`;
    const originalConnect = process.env.LOHRA_OLLAMA_CONNECT_URL;
    process.env.LOHRA_OLLAMA_CONNECT_URL = url;
    try {
      const { probeOllamaDown } = await import("../src/doctor/snapshot.js");
      const status = await probeOllamaDown();
      expect(status.detail).toBe("invalid JSON");
    } finally {
      if (originalConnect === undefined) delete process.env.LOHRA_OLLAMA_CONNECT_URL;
      else process.env.LOHRA_OLLAMA_CONNECT_URL = originalConnect;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
