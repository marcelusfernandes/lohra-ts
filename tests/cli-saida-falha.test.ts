import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { endAfterFailure, runCli, type CliIo, type FlushableStream } from "../src/cli.js";
import { failureReportLines } from "../src/cli/failure-messages.js";

const repoRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-saida-falha-"));
  roots.push(root);
  return root;
}

function environment(root: string): Record<string, string> {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    LOHRA_HOME: join(home, ".lohra"),
    CODEX_HOME: join(root, "codex"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TZ: "UTC",
  };
}

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(
  argv: readonly string[],
  env: Record<string, string>,
  probeOllama: () => Promise<boolean>,
): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    environment: env,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    probeOllama,
  };
  const code = await runCli(argv, io);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** `doctor` probes Ollama before it does anything else, so a probe that
 * rejects is a command that throws after the arguments were accepted. */
function invokeThrowing(failure: unknown, argv: readonly string[]): Promise<Outcome> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is one of the cases under test.
  return invoke(argv, environment(scratchRoot()), () => Promise.reject(failure));
}

/** The home path is a regular file, so every command throws once it reads the
 * profile's `.env`, on any platform. */
function invokeWithBrokenHome(argv: readonly string[]): Promise<Outcome> {
  const env = environment(scratchRoot());
  writeFileSync(env.LOHRA_HOME as string, "not a directory");
  return invoke(argv, env, () => Promise.resolve(false));
}

const STACK_FRAME = /^\s+at /mu;

describe("the report of a failure names the kind of error", () => {
  it("prefixes the name of an error that is not a plain Error, at every level", () => {
    expect(
      failureReportLines(new TypeError("Cannot read properties of undefined (reading 'x')")),
    ).toEqual(["TypeError: Cannot read properties of undefined (reading 'x')"]);

    const chain = new Error("outer", {
      cause: new RangeError("inner", { cause: new SyntaxError("root") }),
    });
    expect(failureReportLines(chain)).toEqual([
      "outer",
      "caused by: RangeError: inner",
      "caused by: SyntaxError: root",
    ]);

    const custom = Object.assign(new Error("refused"), { name: "OAuthError" });
    expect(failureReportLines(custom)).toEqual(["OAuthError: refused"]);
  });

  it("leaves the message of a plain Error as it is", () => {
    expect(failureReportLines(new Error("lonely failure"))).toEqual(["lonely failure"]);
  });

  it("says the name of the error instead of an empty message, never a blank line", () => {
    expect(failureReportLines(new Error())).toEqual(["Error"]);
    expect(failureReportLines(new TypeError(""))).toEqual(["TypeError"]);
    expect(failureReportLines(new Error("   "))).toEqual(["Error"]);
    expect(failureReportLines(new Error("outer", { cause: new Error() }))).toEqual([
      "outer",
      "caused by: Error",
    ]);
    expect(failureReportLines("")).toEqual(["''"]);
  });

  it("reaches the user as error: TypeError: … on stderr, for a real TypeError", async () => {
    const outcome = await invokeThrowing(
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      ["doctor"],
    );

    expect(outcome.stderr).toBe(
      "error: TypeError: Cannot read properties of undefined (reading 'x')\n",
    );
    expect(outcome.stderr).not.toMatch(STACK_FRAME);
    expect(outcome.code).toBe(1);
  });

  it("reaches the user as a single non-empty line for new Error()", async () => {
    const outcome = await invokeThrowing(new Error(), ["doctor"]);

    expect(outcome.stderr).toBe("error: Error\n");
    expect(outcome.code).toBe(1);
  });
});

describe("a level with no message of its own adds no empty caused by: line", () => {
  it("shows the members of an AggregateError with an empty message, and nothing blank", () => {
    const refused = new Error("connect ECONNREFUSED ::1:11434");
    const refusedAgain = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    const aggregate = new AggregateError([refused, refusedAgain]);
    expect(aggregate.message).toBe("");

    const lines = failureReportLines(new TypeError("fetch failed", { cause: aggregate }));

    expect(lines).toEqual([
      "TypeError: fetch failed",
      "caused by: connect ECONNREFUSED ::1:11434",
      "caused by: connect ECONNREFUSED 127.0.0.1:11434",
    ]);
    expect(lines.every((line) => line.trim() !== "" && !/caused by:\s*$/u.test(line))).toBe(true);
  });

  it("keeps the cause of an AggregateError with an empty message, and its members", () => {
    const primary = new Error("primary write failure");
    const cleanup = new Error("stage cleanup failure");
    const aggregate = new AggregateError([primary, cleanup], "", { cause: primary });

    expect(failureReportLines(new Error("outer", { cause: aggregate }))).toEqual([
      "outer",
      "caused by: primary write failure",
      "caused by: stage cleanup failure",
    ]);
  });

  it("starts the report at the first member when the AggregateError itself is the failure", () => {
    expect(
      failureReportLines(new AggregateError([new Error("first"), new Error("second")])),
    ).toEqual(["first", "caused by: second"]);
  });

  it("names an AggregateError that has no message and nothing under it", () => {
    expect(failureReportLines(new AggregateError([]))).toEqual(["AggregateError"]);
  });

  it("keeps an AggregateError message as it is, because it only groups its members", () => {
    expect(
      failureReportLines(new AggregateError([new Error("member")], "write and cleanup failed")),
    ).toEqual(["write and cleanup failed", "caused by: member"]);
  });

  it("still names each object once, in a cycle and in a shared cause", () => {
    const first = new Error("first of the cycle");
    const second = new TypeError("second of the cycle", { cause: first });
    first.cause = second;
    expect(failureReportLines(first)).toEqual([
      "first of the cycle",
      "caused by: TypeError: second of the cycle",
    ]);

    const shared = new Error("shared");
    const both = new AggregateError([shared, shared], "both failed", { cause: shared });
    expect(failureReportLines(both)).toEqual(["both failed", "caused by: shared"]);
  });

  it("reports a value that is not an Error as its text", () => {
    expect(failureReportLines("plain string failure")).toEqual(["plain string failure"]);
    expect(failureReportLines({ code: "E_ODD" })).toEqual(["{ code: 'E_ODD' }"]);
    expect(failureReportLines(new Error("wrapper", { cause: "bare cause" }))).toEqual([
      "wrapper",
      "caused by: bare cause",
    ]);
  });
});

describe("the JSON envelope of a failure follows the parser's notion of --json", () => {
  it('answers {"error": …} on stdout for the abbreviated doctor --js', async () => {
    const outcome = await invokeThrowing(new TypeError("boom"), ["doctor", "--js"]);

    expect(JSON.parse(outcome.stdout)).toEqual({ error: "TypeError: boom" });
    expect(outcome.stdout).toBe('{"error": "TypeError: boom"}\n');
    expect(outcome.stderr).toBe("error: TypeError: boom\n");
    expect(outcome.code).toBe(1);
  });

  it("still answers the envelope for the exact --json and for the inline position", async () => {
    const exact = await invokeThrowing(new Error("boom"), ["doctor", "--json"]);
    expect(exact.stdout).toBe('{"error": "boom"}\n');

    const first = await invokeThrowing(new Error("boom"), ["doctor", "--no-input", "--json"]);
    expect(first.stdout).toBe('{"error": "boom"}\n');
  });

  it("does not turn on the envelope for a --json that comes after --", async () => {
    const outcome = await invokeWithBrokenHome(["chat", "--", "--json"]);

    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/^error: \S/u);
    expect(outcome.code).toBe(1);
  });

  it("gives no envelope when the command was not asked for JSON", async () => {
    const outcome = await invokeThrowing(new Error("boom"), ["doctor"]);

    expect(outcome.stdout).toBe("");
  });
});

describe("endAfterFailure", () => {
  interface FakeStream extends FlushableStream {
    readonly requests: (() => void)[];
  }

  function fakeStream(state: { destroyed?: boolean } = {}): FakeStream {
    const requests: (() => void)[] = [];
    return {
      destroyed: state.destroyed ?? false,
      writable: true,
      requests,
      write: (_chunk, callback) => {
        requests.push(callback);
        return true;
      },
    };
  }

  it("ends the process with the reported code after the grace, once both streams flushed", async () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const exit = vi.fn<(code: number) => void>();

    const timer = endAfterFailure(1, { streams: [stdout, stderr], exit, graceMs: 20 });

    expect(exit).not.toHaveBeenCalled();
    expect(stdout.requests).toHaveLength(0);
    await vi.waitFor(() => {
      expect(stdout.requests).toHaveLength(1);
      expect(stderr.requests).toHaveLength(1);
    });
    expect(exit).not.toHaveBeenCalled();

    stdout.requests[0]?.();
    await new Promise((release) => setTimeout(release, 20));
    expect(exit).not.toHaveBeenCalled();

    stderr.requests[0]?.();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });
    expect(exit).toHaveBeenCalledWith(1);
    clearTimeout(timer);
  });

  it("does not hold a process that ended by itself: the timer is unref'd", () => {
    const timer = endAfterFailure(1, {
      streams: [],
      exit: () => undefined,
      graceMs: 60_000,
    });

    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });

  it("does not wait for a stream that can no longer be written to", async () => {
    const gone = fakeStream({ destroyed: true });
    const exit = vi.fn<(code: number) => void>();

    endAfterFailure(3, { streams: [gone], exit, graceMs: 1 });

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(3);
    });
    expect(gone.requests).toHaveLength(0);
  });
});

interface ProcessRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly hungAfterReport: boolean;
  readonly exitCalls: readonly string[];
}

/** Loaded before the CLI in the child: it leaves a server listening (the leaked
 * handle), can release it later, can make `http.get` throw a long chain, and
 * records every call to `process.exit` in a file instead of the streams. */
const PRELOAD = `
import { appendFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const marks = process.env.LOHRA_TEST_EXIT_MARKS;
const realExit = process.exit;
process.exit = (code) => {
  appendFileSync(marks, "exit(" + String(code) + ")\\n");
  return realExit.call(process, code);
};

const server = net.createServer().listen(0, "127.0.0.1");
const release = process.env.LOHRA_TEST_RELEASE_MS;
if (release !== undefined) setTimeout(() => server.close(), Number(release));

const depth = process.env.LOHRA_TEST_CHAIN_DEPTH;
if (depth !== undefined) {
  let failure = new Error("root of the chain");
  for (let level = 1; level <= Number(depth); level += 1) {
    failure = new Error("level " + String(level) + " " + "x".repeat(200), { cause: failure });
  }
  http.get = () => {
    throw failure;
  };
  syncBuiltinESMExports();
}
`;

const WATCHDOG_MS = 3_000;

/** Runs the real CLI in a child process. The watchdog starts when the first
 * byte of output arrives (the report is out) and kills a child that is still
 * alive WATCHDOG_MS later, which is what `hungAfterReport` records. */
async function runProcess(
  argv: readonly string[],
  extraEnvironment: Record<string, string>,
): Promise<ProcessRun> {
  const root = scratchRoot();
  const preload = join(root, "preload.mjs");
  const marks = join(root, "exit-marks.txt");
  writeFileSync(preload, PRELOAD);
  writeFileSync(marks, "");
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      "--import",
      "tsx",
      resolve(repoRoot, "src/cli.ts"),
      ...argv,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...environment(root),
        LOHRA_TEST_EXIT_MARKS: marks,
        NO_COLOR: "1",
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let hungAfterReport = false;
  let watchdog: NodeJS.Timeout | undefined;
  const arm = (): void => {
    watchdog ??= setTimeout(() => {
      hungAfterReport = true;
      child.kill("SIGKILL");
    }, WATCHDOG_MS);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    arm();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    arm();
  });
  const code = await new Promise<number | null>((settle, fail) => {
    child.once("error", fail);
    child.once("close", settle);
  });
  clearTimeout(watchdog);
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    hungAfterReport,
    exitCalls: readFileSync(marks, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  };
}

describe("a command that fails while a handle is still open", () => {
  it("ends with the reported code and the whole report, and answers the abbreviated envelope", async () => {
    const run = await runProcess(["doctor", "--js"], {
      LOHRA_OLLAMA_CONNECT_URL: "not a url",
    });

    expect(run.hungAfterReport).toBe(false);
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as { error: string };
    expect(envelope.error).toMatch(/^TypeError: \S/u);
    expect(run.stderr).toBe(`error: ${envelope.error}\n`);
    expect(run.exitCalls).toEqual(["exit(1)"]);
  });

  it("does not cut a long report when it forces the end", async () => {
    const depth = 300;
    const run = await runProcess(["doctor"], { LOHRA_TEST_CHAIN_DEPTH: String(depth) });

    expect(run.hungAfterReport).toBe(false);
    expect(run.code).toBe(1);
    const expected = [
      `error: level ${String(depth)} ${"x".repeat(200)}`,
      ...Array.from(
        { length: depth - 1 },
        (_, index) => `caused by: level ${String(depth - 1 - index)} ${"x".repeat(200)}`,
      ),
      "caused by: root of the chain",
      "",
    ];
    expect(run.stderr).toBe(expected.join("\n"));
    expect(run.stdout).toBe("");
    expect(run.exitCalls).toEqual(["exit(1)"]);
  });
});

describe("a command that succeeds while a handle is still open", () => {
  it("is left to end by itself, with no forced process.exit", async () => {
    const run = await runProcess(["--version"], { LOHRA_TEST_RELEASE_MS: "1500" });

    expect(run.hungAfterReport).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^lohra \S+\n$/u);
    expect(run.stderr).toBe("");
    expect(run.exitCalls).toEqual([]);
  });
});
