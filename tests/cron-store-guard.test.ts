import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withCronStoreGuard } from "../src/cron/store-guard.js";

const worker = resolve(import.meta.dirname, "workers", "cron-store-guard-worker.ts");
const tsxLoader = import.meta.resolve("tsx");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; jobs: string; events: string } {
  const root = mkdtempSync(join(tmpdir(), "lohra-cron-guard-"));
  roots.push(root);
  return { root, jobs: join(root, "cron", "jobs.json"), events: join(root, "events.txt") };
}

function launch(
  root: string,
  jobs: string,
  events: string,
  label: string,
  mode: "hold" | "enter" | "throw",
): { child: ChildProcessWithoutNullStreams; output: { stdout: string; stderr: string } } {
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, worker, jobs, mode, join(root, `release-${label}`), events, label],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        LOHRA_HOME: join(root, "lohra"),
        CODEX_HOME: join(root, "codex"),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  children.add(child);
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => (output.stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString("utf8")));
  return { child, output };
}

async function waitFor(
  condition: () => boolean,
  failure: () => string,
  timeoutMs = 7_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function closeOf(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve) => {
    child.once("close", (code) => {
      resolve(code);
    });
  });
}

describe("cron store transactional guard", () => {
  it("serializes two independent PIDs across an explicit barrier", async () => {
    const { root, jobs, events } = fixture();
    const a = launch(root, jobs, events, "A", "hold");
    await waitFor(
      () => a.output.stdout.includes("ENTER"),
      () => a.output.stderr,
    );
    const b = launch(root, jobs, events, "B", "enter");
    await waitFor(
      () => b.output.stdout.includes("READY"),
      () => b.output.stderr,
    );
    writeFileSync(join(root, "release-A"), "go");
    expect(await closeOf(a.child)).toBe(0);
    expect(await closeOf(b.child)).toBe(0);
    expect(readFileSync(events, "utf8").trim().split(/\r?\n/u)).toEqual([
      "ENTER-A",
      "EXIT-A",
      "ENTER-B",
      "EXIT-B",
    ]);
    expect(a.child.pid).not.toBe(b.child.pid);
  });

  it("never steals a living paused owner when the contender reaches its deadline", async () => {
    const { root, jobs, events } = fixture();
    const a = launch(root, jobs, events, "A", "hold");
    await waitFor(
      () => a.output.stdout.includes("ENTER"),
      () => a.output.stderr,
    );
    const b = launch(root, jobs, events, "B", "enter");
    await waitFor(
      () => b.output.stdout.includes("READY"),
      () => b.output.stderr,
    );
    expect(await closeOf(b.child)).toBe(2);
    expect(b.output.stdout).not.toContain("ENTER");
    expect(b.output.stderr).toMatch(/busy|locked|timeout/iu);
    expect(readFileSync(events, "utf8")).toBe("ENTER-A\n");
    writeFileSync(join(root, "release-A"), "go");
    expect(await closeOf(a.child)).toBe(0);
    const c = launch(root, jobs, events, "C", "enter");
    expect(await closeOf(c.child)).toBe(0);
  });

  it("releases ownership after the holder is killed, without deleting a foreign lock", async () => {
    const { root, jobs, events } = fixture();
    const a = launch(root, jobs, events, "A", "hold");
    await waitFor(
      () => a.output.stdout.includes("ENTER"),
      () => a.output.stderr,
    );
    a.child.kill("SIGKILL");
    await closeOf(a.child);
    const started = Date.now();
    const b = launch(root, jobs, events, "B", "enter");
    expect(await closeOf(b.child)).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readFileSync(events, "utf8").trim().split(/\r?\n/u)).toEqual([
      "ENTER-A",
      "ENTER-B",
      "EXIT-B",
    ]);
  });

  it("propagates callback failure and closes the connection; IO errors retain a cause", () => {
    const { root, jobs } = fixture();
    const sentinel = new Error("CALLBACK_SENTINEL");
    expect(() =>
      withCronStoreGuard(jobs, () => {
        throw sentinel;
      }),
    ).toThrow(sentinel);
    expect(withCronStoreGuard(jobs, () => "reopened")).toBe("reopened");
    const blockingFile = join(root, "file");
    writeFileSync(blockingFile, "not a directory");
    try {
      withCronStoreGuard(join(blockingFile, "jobs.json"), () => "unreachable");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });
});
