// Process lifecycle for the T18 [scheduler-bilateral] evidence class: boots
// the REAL oracle `lohra dashboard` (background scheduler thread, decision
// 9/11) and the REAL candidate scheduler launcher, both pointed at their own
// fake upstream so job firings are observable as upstream request counts.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";

import { startFakeUpstream, type FakeUpstream } from "../openai-server/fake-upstream.js";
import { oraclePython, type RuntimePaths } from "./harness.js";

const oracleDashboardLauncher = resolve(import.meta.dirname, "oracle-dashboard-launcher.py");
const candidateSchedulerLauncher = resolve(import.meta.dirname, "candidate-scheduler-launcher.mjs");
const oracleCheckout = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";

export function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

export interface ExitInfo {
  readonly exited: boolean;
  readonly code: number | null;
}

export interface SchedulerProcess {
  readonly upstream: FakeUpstream;
  readonly paths: RuntimePaths;
  readonly exitInfo: () => ExitInfo;
  stop(): Promise<void>;
}

interface StartOptions {
  readonly paths: RuntimePaths;
  readonly tz?: string;
  readonly tickIntervalMs?: number;
  /** Selects a named mutation from `t18-mutant-loader.mjs` (assertions
   * 24/44's self-tests) -- candidate-side only. */
  readonly mutant?: string;
}

function spawnAndCollect(
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
): { readonly child: ChildProcess; readonly exitInfo: () => ExitInfo; readonly stop: () => Promise<void> } {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let settled = false;
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    settled = true;
    exitCode = code;
  });
  const stop = (): Promise<void> =>
    new Promise((resolveStop) => {
      if (settled) {
        resolveStop();
        return;
      }
      child.once("exit", () => {
        resolveStop();
      });
      child.kill("SIGINT");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 3000);
      setTimeout(resolveStop, 3500);
    });
  return { child, exitInfo: () => ({ exited: settled, code: exitCode }), stop };
}

/** Boots the real oracle `lohra dashboard` (its background scheduler thread
 * is `scheduler.py`'s real `run_scheduler_loop`), pointed at a fresh fake
 * upstream. jobs.json must already be planted in `paths.home` before this
 * is called — the dashboard's scheduler thread reads whatever is there at
 * boot and on every subsequent tick. */
export async function startOracleScheduler(options: StartOptions): Promise<SchedulerProcess> {
  const upstream = await startFakeUpstream();
  const port = await allocatePort();
  const env: Record<string, string> = {
    HOME: options.paths.home,
    LOHRA_HOME: options.paths.home,
    TMPDIR: options.paths.tmp,
    PATH: "/usr/bin:/bin",
    FAKE_API_KEY: "FAKE-KEY-T18",
    FAKE_BASE_URL: upstream.url,
    LOHRA_PORT: String(port),
    PYTHONPATH: join(oracleCheckout, "backend"),
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    ...(options.tz === undefined ? {} : { TZ: options.tz }),
  };
  const { stop, exitInfo } = spawnAndCollect(oraclePython, [oracleDashboardLauncher], env, options.paths.tmp);
  return { upstream, paths: options.paths, exitInfo, stop: () => stop().then(() => upstream.close()) };
}

/** Boots the real candidate scheduler launcher (a fresh Node process
 * importing `dist/cron/scheduler.js`), pointed at its own fresh fake
 * upstream. Fast default tick interval (500ms) so multi-tick scenarios
 * don't wait on the product's real 60s default. */
export async function startCandidateScheduler(options: StartOptions): Promise<SchedulerProcess> {
  const upstream = await startFakeUpstream();
  mkdirSync(join(options.paths.home, "cron"), { recursive: true });
  const env: Record<string, string> = {
    HOME: options.paths.home,
    LOHRA_HOME: options.paths.home,
    TMPDIR: options.paths.tmp,
    PATH: "/usr/bin:/bin",
    FAKE_BASE_URL: upstream.url,
    LOHRA_T18_TICK_MS: String(options.tickIntervalMs ?? 500),
    ...(options.tz === undefined ? {} : { TZ: options.tz }),
    ...(options.mutant === undefined ? {} : { T18_MUTANT: options.mutant }),
  };
  const { stop, exitInfo } = spawnAndCollect(process.execPath, [candidateSchedulerLauncher], env, options.paths.tmp);
  return { upstream, paths: options.paths, exitInfo, stop: () => stop().then(() => upstream.close()) };
}

export function waitFor(condition: () => boolean, timeoutMs = 8000, intervalMs = 100): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolveWait) => {
    const attempt = (): void => {
      if (condition()) {
        resolveWait(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolveWait(false);
        return;
      }
      setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

export function readSchedulerLog(home: string): string {
  try {
    return readFileSync(join(home, "cron", "scheduler.log"), "utf8");
  } catch {
    return "";
  }
}
