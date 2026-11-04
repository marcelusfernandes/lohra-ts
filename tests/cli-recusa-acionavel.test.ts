import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { atomicWritePrivate0600, type AtomicWriteOperations } from "../src/auth/json-file.js";
import { runCli, type CliIo } from "../src/cli.js";
import { upsertEnvFile } from "../src/onboarding/env-write.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "lohra-recusa-"));
  roots.push(root);
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

/** `doctor` probes Ollama before it does anything else, so a probe that
 * rejects is a command that throws after the arguments were accepted. */
async function invokeThrowing(
  failure: unknown,
  argv: readonly string[] = ["doctor"],
): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    environment: environment(),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is one of the cases under test.
    probeOllama: () => Promise.reject(failure),
  };
  const code = await runCli(argv, io);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

const STACK_FRAME = /^\s+at /mu;

const unapproved =
  "Windows DACL grants access to unapproved identities: BUILTIN\\Users (S-1-5-32-545). Move or rename this path so Lohra recreates it protected, or point LOHRA_HOME at a new path, then save the credential again";

function refusedPrivateWrite(target: string, cause: unknown): Error {
  const unused = (): never => {
    throw new Error("must not be reached");
  };
  const operations: AtomicWriteOperations = {
    platform: "win32",
    prepare: () => {
      throw cause;
    },
    mkdir: unused,
    open: unused,
    write: unused,
    fsync: unused,
    close: unused,
    rename: unused,
    unlink: unused,
    pid: 1,
    now: () => 2,
  };
  try {
    atomicWritePrivate0600(target, "fictional-token", operations);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the private write to be refused");
}

describe("a failure that reaches the CLI entry point", () => {
  it("prints error: and one line per cause, without a stack trace, and exits non-zero", async () => {
    const root = new Error("root level 3");
    const middle = new Error("middle level 2", { cause: root });
    const top = new Error("top level 1", { cause: middle });

    const outcome = await invokeThrowing(top);

    expect(outcome.stderr).toBe(
      "error: top level 1\ncaused by: middle level 2\ncaused by: root level 3\n",
    );
    expect(outcome.stderr).not.toMatch(STACK_FRAME);
    expect(outcome.stdout).toBe("");
    expect(outcome.code).not.toBe(0);
  });

  it("prints a failure without a cause as a single error: line", async () => {
    const outcome = await invokeThrowing(new Error("lonely failure"));

    expect(outcome.stderr).toBe("error: lonely failure\n");
    expect(outcome.code).not.toBe(0);
  });

  it("puts the same message and causes in the stdout envelope under --json", async () => {
    const root = new Error("root level 3");
    const middle = new Error("middle level 2", { cause: root });
    const top = new Error("top level 1", { cause: middle });

    const outcome = await invokeThrowing(top, ["doctor", "--json"]);

    const envelope = JSON.parse(outcome.stdout) as { error: string };
    expect(Object.keys(envelope)).toEqual(["error"]);
    expect(envelope.error).toBe("top level 1\ncaused by: middle level 2\ncaused by: root level 3");
    expect(outcome.stderr).toBe(
      "error: top level 1\ncaused by: middle level 2\ncaused by: root level 3\n",
    );
    expect(outcome.code).not.toBe(0);
  });

  it("keeps the members of an AggregateError next to its cause, each message once", async () => {
    const primary = new Error("primary write failure");
    const cleanup = new Error("stage cleanup failure");
    const combined = new AggregateError([primary, cleanup], "write and cleanup failed", {
      cause: primary,
    });

    const outcome = await invokeThrowing(new Error("outer", { cause: combined }));

    expect(outcome.stderr.split("\n")).toEqual([
      "error: outer",
      "caused by: write and cleanup failed",
      "caused by: primary write failure",
      "caused by: stage cleanup failure",
      "",
    ]);
  });

  it("ends on a cycle of causes, naming each message once", async () => {
    const first = new Error("first of the cycle");
    const second = new Error("second of the cycle", { cause: first });
    first.cause = second;

    const outcome = await invokeThrowing(first);

    expect(outcome.stderr).toBe("error: first of the cycle\ncaused by: second of the cycle\n");
    expect(outcome.code).not.toBe(0);
  });

  it("reports a rejection that is not an Error, and a cause that is not an Error", async () => {
    const plain = await invokeThrowing("plain string failure");
    expect(plain.stderr).toBe("error: plain string failure\n");
    expect(plain.code).not.toBe(0);

    const wrapped = await invokeThrowing(new Error("wrapper", { cause: "bare cause" }));
    expect(wrapped.stderr).toBe("error: wrapper\ncaused by: bare cause\n");
  });

  it("shows where a private write was refused and the guidance in the first two lines", async () => {
    const target = join(tmpdir(), "lohra-home", "auth.json");
    const refusal = refusedPrivateWrite(target, new Error(unapproved));

    const outcome = await invokeThrowing(refusal);

    const lines = outcome.stderr.split("\n");
    expect(lines[0]).toBe(`error: Could not save private credentials at ${target}`);
    expect(lines[1]).toBe(`caused by: ${unapproved}`);
    expect(lines).toHaveLength(3);
    expect(outcome.stderr).not.toContain("private fixed NTFS");
    expect(outcome.stderr).not.toMatch(STACK_FRAME);
    expect(outcome.code).not.toBe(0);
  });

  it("shows the cleanup failure of a refused write as well as the refusal", async () => {
    const target = join(tmpdir(), "lohra-home", "auth.json");
    const refusal = new Error("access refused");
    const cleanup = new Error("stage could not be removed");
    const combined = new AggregateError(
      [refusal, cleanup],
      "Windows auth write and cleanup failed",
      {
        cause: refusal,
      },
    );

    const outcome = await invokeThrowing(refusedPrivateWrite(target, combined));

    expect(outcome.stderr).toContain("caused by: access refused\n");
    expect(outcome.stderr).toContain("caused by: stage could not be removed\n");
    expect(outcome.stderr).not.toMatch(STACK_FRAME);
  });

  it("shows where a private .env write was refused, with the refusal as the next line", async () => {
    const path = join(tmpdir(), "lohra-home", ".env");
    const refusal = new Error(unapproved);
    const forbidden = (): never => {
      throw new Error("must not be reached");
    };
    let failure: unknown;
    try {
      upsertEnvFile(
        path,
        { OPENAI_API_KEY: "fictional" },
        {
          platform: "win32",
          readText: () => "",
          privateWrite: () => {
            throw refusal;
          },
          writeText: forbidden,
          chmod600: forbidden,
          replace: forbidden,
        },
      );
    } catch (error) {
      failure = error;
    }

    const outcome = await invokeThrowing(failure);

    expect(outcome.stderr).toBe(
      `error: Could not save private .env at ${path}\ncaused by: ${unapproved}\n`,
    );
    expect(outcome.stderr).not.toContain("private fixed NTFS");
  });

  it("turns an unwritable home into a short error: report instead of an unhandled rejection", async () => {
    const env = environment();
    // The home path is a regular file, so saving the preference cannot succeed
    // on any platform; only the shape of the report is asserted here.
    writeFileSync(env.LOHRA_HOME as string, "not a directory");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      environment: env,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      probeOllama: () => Promise.resolve(false),
    };

    const code = await runCli(["auth", "prefer", "api_key", "--no-input"], io);

    expect(code).not.toBe(0);
    expect(stderr.join("")).toMatch(/^error: \S/u);
    expect(stderr.join("")).not.toMatch(STACK_FRAME);
    expect(stdout.join("")).toBe("");
  });
});
