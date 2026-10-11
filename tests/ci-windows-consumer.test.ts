import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/windows-consumer.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");

function jobBlock(yaml: string, job: string): string | null {
  const lines = yaml.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

it("distinguishes an absent consumer job from the real configured job", () => {
  expect(jobBlock("jobs:\n  checks:\n    runs-on: ubuntu-latest\n", "consumer-windows")).toBeNull();
  expect(jobBlock(workflow, "consumer-windows")).not.toBeNull();
});

it("uses an informative bounded native Windows 20/22 matrix and default checkout", () => {
  const job = jobBlock(workflow, "consumer-windows") ?? "";
  expect(job).toMatch(/runs-on:\s*windows-latest/u);
  expect(job).toMatch(/node:\s*\["20", "22"\]/u);
  expect(job).toContain("continue-on-error: true");
  expect(job).toMatch(/timeout-minutes:\s*\d+/u);
  expect(job).toContain("actions/checkout@v4");
  expect(job).toContain("actions/setup-node@v4");
  expect(job).not.toContain("core.protectNTFS=false");
});

it("records install, build and tarball consumer in order with cause-preserving status", () => {
  const job = jobBlock(workflow, "consumer-windows") ?? "";
  const commands = ["npm ci", "npm run build", "npm run pack:check"];
  let previous = -1;
  for (const command of commands) {
    const position = job.indexOf(`Command = '${command}'`);
    expect(position, `missing ${command}`).toBeGreaterThan(previous);
    previous = position;
  }
  expect(job).toContain("$LASTEXITCODE");
  expect(job).toContain("$env:GITHUB_STEP_SUMMARY");
  expect(job).toContain("if: always()");
  expect(job).toContain("PASS");
  expect(job).toContain("FAIL");
  expect(job).toContain("BLOCKED");
});

it("separates candidate from checked-out SHA and does not claim npm shim coverage", () => {
  const job = jobBlock(workflow, "consumer-windows") ?? "";
  expect(job).toContain("CANDIDATE_SHA: ${{ github.event.pull_request.head.sha }}");
  expect(job).toContain("EXECUTION_SHA: ${{ github.sha }}");
  expect(job).toContain("git rev-parse HEAD");
  expect(job).toContain("$env:RUNNER_ARCH");
  expect(job).toContain("better-sqlite3 prebuild");
  expect(job).toContain("node-pty prebuild");
  expect(job).toContain("CLI JS entry");
  expect(job).toContain("npm shim: NOT_TESTED");
  expect(job).toContain("PACK_CONSUMER_RESULT_INVALID");
});
