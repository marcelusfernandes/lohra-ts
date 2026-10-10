import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CronStore } from "../src/cron/store.js";

const worker = resolve(import.meta.dirname, "workers", "cron-claim-worker.ts");
const tsxLoader = import.meta.resolve("tsx");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const closes = new WeakMap<ChildProcessWithoutNullStreams, Promise<number | null>>();

function fixture(): { home: string; jobId: string } {
  const home = mkdtempSync(join(tmpdir(), "lohra-cron-dispatch-"));
  roots.push(home);
  const job = new CronStore(home).add({ name: "once", prompt: "p", type: "once", value: 100 });
  return { home, jobId: job.id };
}

function launch(home: string, mode: string, label: string) {
  const ready = join(home, `ready-${label}`);
  const start = join(home, `start-${label}`);
  const gate = join(home, `gate-${label}`);
  const gateRelease = join(home, `gate-release-${label}`);
  const result = join(home, `result-${label}.json`);
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, worker, mode, home, ready, start, gate, gateRelease, result],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOHRA_HOME: join(home, "lohra"),
        CODEX_HOME: join(home, "codex"),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  closes.set(child, closed);
  return { child, ready, start, gate, gateRelease, result, closed, stderr: () => stderr };
}

async function until(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`scheduler did not reach barrier: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function outcome(path: string): {
  callbacks: number;
  results: Array<{ jobId: string; ok: boolean }>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    callbacks: number;
    results: Array<{ jobId: string; ok: boolean }>;
  };
}

afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all([...children].map(async (child) => await closes.get(child)));
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("two schedulers across processes", () => {
  it("dispatches a due once job exactly once while the first callback remains live", async () => {
    const { home, jobId } = fixture();
    const a = launch(home, "during-callback", "a");
    const b = launch(home, "run", "b");
    await Promise.all([until(a.ready), until(b.ready)]);
    expect(a.child.pid).not.toBe(b.child.pid);
    writeFileSync(a.start, "go");
    await until(a.gate);
    writeFileSync(b.start, "go");
    expect(await b.closed, b.stderr()).toBe(0);
    writeFileSync(a.gateRelease, "go");
    expect(await a.closed, a.stderr()).toBe(0);
    expect(outcome(a.result)).toEqual({ callbacks: 1, results: [{ jobId, ok: true }] });
    expect(outcome(b.result)).toEqual({ callbacks: 0, results: [] });
  }, 12_000);

  it("allows another scheduler after a process dies before claim", async () => {
    const { home, jobId } = fixture();
    const a = launch(home, "before-claim", "a");
    await until(a.ready);
    writeFileSync(a.start, "go");
    await until(a.gate);
    a.child.kill("SIGKILL");
    await a.closed;
    const b = launch(home, "run", "b");
    await until(b.ready);
    writeFileSync(b.start, "go");
    expect(await b.closed, b.stderr()).toBe(0);
    expect(outcome(b.result)).toEqual({ callbacks: 1, results: [{ jobId, ok: true }] });
  }, 12_000);

  for (const mode of ["after-commit", "during-callback"]) {
    it(`does not retry after a process dies ${mode}`, async () => {
      const { home } = fixture();
      const a = launch(home, mode, "a");
      await until(a.ready);
      writeFileSync(a.start, "go");
      await until(a.gate);
      a.child.kill("SIGKILL");
      await a.closed;
      const b = launch(home, "run", "b");
      await until(b.ready);
      writeFileSync(b.start, "go");
      expect(await b.closed, b.stderr()).toBe(0);
      expect(outcome(b.result)).toEqual({ callbacks: 0, results: [] });
    }, 12_000);
  }
});
