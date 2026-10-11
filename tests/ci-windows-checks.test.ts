import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const ciPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(ciPath, "utf8");

function jobBlock(yaml: string, job: string): string | null {
  const lines = yaml.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

it("distinguishes an absent Windows job from the actual configured job", () => {
  expect(jobBlock("jobs:\n  checks:\n    runs-on: ubuntu-latest\n", "windows-checks")).toBeNull();
  expect(jobBlock(workflow, "windows-checks")).not.toBeNull();
});

it("uses a native Windows 20/22 matrix with default checkout and an informative bounded job", () => {
  const job = jobBlock(workflow, "windows-checks") ?? "";
  expect(job).toMatch(/runs-on:\s*windows-latest/u);
  expect(job).toMatch(/node:\s*\["20", "22"\]/u);
  expect(job).toMatch(/continue-on-error:\s*true/u);
  expect(job).toMatch(/timeout-minutes:\s*\d+/u);
  expect(job).toMatch(
    /- uses: actions\/checkout@v4\s*\n\s*(?:id: \S+\s*\n\s*)?(?:continue-on-error: true\s*\n\s*)?- uses: actions\/setup-node@v4/u,
  );
  expect(job).not.toContain("core.protectNTFS=false");
});

it("records every command in canonical order, including failed or blocked stages", () => {
  const job = jobBlock(workflow, "windows-checks") ?? "";
  const commands = [
    "npm ci",
    "npm run build",
    "npm run typecheck",
    "npm run lint",
    "npm run format:check",
    "npm test",
  ];
  let last = -1;
  for (const command of commands) {
    const position = job.indexOf(`Command = '${command}'`);
    expect(position, `missing ${command}`).toBeGreaterThan(last);
    last = position;
  }
  expect(job).toContain("$env:GITHUB_STEP_SUMMARY");
  expect(job).toContain("$env:CANDIDATE_SHA");
  expect(job).toContain("EXECUTION_SHA: ${{ github.sha }}");
  expect(job).toContain("$env:EXECUTION_SHA");
  expect(job).toContain("git rev-parse HEAD");
  expect(job).toContain("$checkoutSha");
  expect(job).toContain("$env:RUNNER_OS");
  expect(job).toContain("$env:RUNNER_ARCH");
  expect(job).toContain("node --version");
  expect(job).toContain("PASS");
  expect(job).toContain("FAIL");
  expect(job).toContain("BLOCKED");
  expect(job).toContain("$LASTEXITCODE");
  expect(job).toContain("if: always()");
});
