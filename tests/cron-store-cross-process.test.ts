import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CronStore } from "../src/cron/store.js";

const worker = resolve(import.meta.dirname, "workers", "cron-store-worker.ts");
const tsxLoader = import.meta.resolve("tsx");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const closes = new WeakMap<ChildProcessWithoutNullStreams, Promise<number | null>>();

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), "lohra-cron-orphan-"));
  roots.push(home);
  return home;
}

function launch(home: string, mode: string, label: string) {
  const ready = join(home, `ready-${label}`);
  const release = join(home, `release-${label}`);
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, worker, mode, home, ready, release],
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
  return { child, ready, release, closed, stderr: () => stderr };
}

async function untilReady(path: string): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`worker did not reach barrier: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all([...children].map(async (child) => await closes.get(child)));
  children.clear();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("CronStore across processes", () => {
  it("does not let a live guard holder be bypassed by list", async () => {
    const home = fixture();
    const holder = launch(home, "hold", "holder");
    await untilReady(holder.ready);
    const contender = launch(home, "list", "contender");
    await untilReady(contender.ready);
    expect(await contender.closed).toBe(2);
    expect(contender.stderr()).toContain("timed out after 2000 ms");
    expect(contender.stderr()).toContain("SQLITE_BUSY");
    writeFileSync(holder.release, "go");
    expect(await holder.closed).toBe(0);
  });

  for (const mode of ["hold", "hold-after-rename"]) {
    it(`recovers after owner death ${mode} with valid JSON within 10 seconds`, async () => {
      const home = fixture();
      const store = new CronStore(home);
      store.add({ name: "initial", prompt: "p", type: "interval", value: 5 });
      const holder = launch(home, mode, "holder");
      await untilReady(holder.ready);
      holder.child.kill("SIGKILL");
      await holder.closed;
      const started = Date.now();
      const jobs = store.list();
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(jobs).toHaveLength(mode === "hold" ? 1 : 2);
      expect(
        () => JSON.parse(readFileSync(join(home, "cron", "jobs.json"), "utf8")) as unknown,
      ).not.toThrow();
    });
  }

  it("preserves concurrent additions from distinct PIDs", async () => {
    const home = fixture();
    const a = launch(home, "add", "a");
    const b = launch(home, "add", "b");
    await Promise.all([untilReady(a.ready), untilReady(b.ready)]);
    writeFileSync(a.release, "go");
    writeFileSync(b.release, "go");
    expect(await a.closed).toBe(0);
    expect(await b.closed).toBe(0);
    expect(new CronStore(home).list()).toHaveLength(2);
  });
});
