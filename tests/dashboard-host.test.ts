// Issue #4: the desktop app (`lohra/desktop/src-tauri/src/backend.rs:136`)
// spawns `lohra dashboard --no-open --host 127.0.0.1 --port <p>`. Today the
// CLI dies on the unrecognized flags (`src/cli/arg-spec.ts:68-74` never
// declared `--host`/`--no-open`), and the HTTP bind is hardcoded to
// `127.0.0.1` (`src/commands/dashboard.ts:339`, `:359`). This file proves:
// (1) the parser accepts both new flags, mirroring `serve`'s `--host`
// precedent (`src/cli/arg-spec.ts:95`); (2) `--host` actually changes the
// bind address, not just the printed banner; (3) a non-loopback `--host`
// combined with `--insecure` is refused with its own CLI-shaped error,
// concretizing the L22 reavaliação (`docs/gate-decision.md`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { parseCommand } from "../src/cli/arg-validation.js";
import { DASHBOARD_SPEC } from "../src/cli/arg-spec.js";
import { runDashboard, type DashboardCommandOptions } from "../src/commands/dashboard.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

describe("DASHBOARD_SPEC — accepts --host and --no-open (issue #4)", () => {
  it("--host takes a value and parses cleanly, exactly like serve's --host", () => {
    const result = parseCommand(DASHBOARD_SPEC, ["--host", "0.0.0.0", "--port", "9130"]);
    expect(result.error).toBeNull();
    expect(result.options.get("--host")).toBe("0.0.0.0");
  });

  it("--no-open is a boolean flag, accepted with no value", () => {
    const result = parseCommand(DASHBOARD_SPEC, ["--no-open"]);
    expect(result.error).toBeNull();
    expect(result.options.get("--no-open")).toBe(true);
  });

  it("the exact desktop app invocation parses without error", () => {
    const result = parseCommand(DASHBOARD_SPEC, [
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "9130",
    ]);
    expect(result.error).toBeNull();
    expect(result.extras).toHaveLength(0);
  });
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-dashboard-host-"));
  roots.push(root);
  return root;
}

// `argv` here is test-only shorthand: `baseOptions` runs it through the
// real `parseCommand(DASHBOARD_SPEC, ...)` cli.ts itself uses, so `flags`
// (what `runDashboard` actually reads, issue #222) is never hand-built out
// of step with the parser -- an `it()` block just writes the argv shape a
// user would type, same as before this file's own field rename.
type BaseOptionsOverrides = Partial<DashboardCommandOptions> & {
  readonly argv?: readonly string[];
};

function baseOptions(overrides: BaseOptionsOverrides = {}) {
  const { argv = ["--provider", "anthropic"], ...rest } = overrides;
  const home = tempHome();
  const stderrLines: string[] = [];
  return {
    flags: parseCommand(DASHBOARD_SPEC, argv).options,
    environment: { ANTHROPIC_API_KEY: "sk-test-key" },
    home,
    codexHome: join(home, "codex"),
    cwd: tmpdir(),
    stderr: (text: string) => stderrLines.push(text),
    port: 0,
    ...rest,
    stderrLines,
  };
}

// Issue #302: `await sleep(50)` used to be how a handful of tests below
// waited for `runDashboard` to finish binding before reading `stderrLines`.
// That races the real boot work between argv parsing and the bind
// (credential resolution, SQLite open, MCP registration -- dashboard.ts's
// own `runDashboard` body) whenever the event loop is busy with other test
// files: reproduced with two full `npm test` runs at once (2/5 rounds),
// `AssertionError: expected false to be true` at this file's "does NOT
// refuse --insecure with an explicit loopback --host (localhost)" -- the
// banner had not reached `stderrLines` yet 50ms in. Never reproduced in 10
// sequential full-suite runs nor 15-30 isolated reruns of this file alone,
// consistent with a starved-event-loop race rather than port or IPv6
// state. `registerShutdownTrigger` is only invoked (dashboard.ts, right
// after the real bind and banner print) once boot has actually finished,
// so it doubles as a ready signal: awaiting it removes the wall-clock race
// instead of guessing a longer delay.
function waitUntilBound(options: { registerShutdownTrigger?: (handler: () => void) => void }): {
  readonly ready: Promise<void>;
  readonly shutdown: () => void;
} {
  let handler: (() => void) | undefined;
  const ready = new Promise<void>((resolveReady) => {
    options.registerShutdownTrigger = (trigger: () => void) => {
      handler = trigger;
      resolveReady();
    };
  });
  return { ready, shutdown: () => handler?.() };
}

describe("runDashboard: --host refuses to combine with --insecure off loopback (issue #4 AC)", () => {
  it("exits 2 with a CLI-shaped error, never opening a socket", async () => {
    const options = baseOptions({
      argv: ["--provider", "anthropic", "--insecure", "--host", "0.0.0.0"],
    });
    const code = await runDashboard(options);
    expect(code).toBe(2);
    const stderr = options.stderrLines.join("");
    expect(stderr).toContain("usage: lohra dashboard");
    expect(stderr).toContain("--insecure");
    expect(stderr).toContain("--host 0.0.0.0");
  });

  it("also refuses a non-loopback hostname other than 0.0.0.0", async () => {
    const options = baseOptions({
      argv: ["--provider", "anthropic", "--insecure", "--host", "203.0.113.5"],
    });
    const code = await runDashboard(options);
    expect(code).toBe(2);
    expect(options.stderrLines.join("")).toContain("--host 203.0.113.5");
  });

  it("does NOT refuse --insecure with an explicit loopback --host (localhost)", async () => {
    const options = baseOptions({
      argv: ["--provider", "anthropic", "--insecure", "--host", "localhost"],
    });
    const { ready, shutdown } = waitUntilBound(options);
    const donePromise = runDashboard(options);
    await ready;
    expect(options.stderrLines.some((line) => line.startsWith("Lohra dashboard:"))).toBe(true);
    shutdown();
    const code = await donePromise;
    expect(code).toBe(0);
  });

  it("without --insecure, a non-loopback --host is accepted (token still required)", async () => {
    const options = baseOptions({
      argv: ["--provider", "anthropic", "--host", "203.0.113.5"],
    });
    // 203.0.113.5 (TEST-NET-3, RFC 5737) is not assigned to this host, so the
    // real bind fails (EADDRNOTAVAIL) -- this only proves the refusal gate
    // itself does not fire before that attempt; the bind outcome itself is
    // not asserted. The rejection is attached synchronously, before any
    // `await`, so it is never briefly unhandled.
    let shutdown: (() => void) | undefined;
    options.registerShutdownTrigger = (handler: () => void) => {
      shutdown = handler;
    };
    const donePromise = runDashboard(options);
    const settled = donePromise.catch(() => undefined);
    await sleep(50);
    const refused = options.stderrLines.some((line) => line.includes("lohra: error:"));
    expect(refused).toBe(false);
    shutdown?.();
    await settled;
  });
});

describe("runDashboard: --host changes the actual bind address (issue #4 AC)", () => {
  it("binds ::1 when given, and the printed banner reflects it", async () => {
    const options = baseOptions({ argv: ["--provider", "anthropic", "--host", "::1"] });
    const { ready, shutdown } = waitUntilBound(options);
    const donePromise = runDashboard(options);
    await ready;
    const boundLine = options.stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
    expect(boundLine).toMatch(/^Lohra dashboard: http:\/\/\[::1\]:\d+\n$/);
    const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);

    // Prove the *actual* bind, not just the printed text: a raw TCP connect
    // to ::1 on the announced port must succeed.
    await new Promise<void>((resolvePromise, reject) => {
      const socket = connect({ host: "::1", port }, () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once("error", reject);
    });

    shutdown();
    const code = await donePromise;
    expect(code).toBe(0);
  });

  it("without --host, the default stays 127.0.0.1", async () => {
    const options = baseOptions();
    const { ready, shutdown } = waitUntilBound(options);
    const donePromise = runDashboard(options);
    await ready;
    const boundLine = options.stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
    expect(boundLine).toMatch(/^Lohra dashboard: http:\/\/127\.0\.0\.1:\d+\n$/);
    shutdown();
    await donePromise;
  });
});

describe("runDashboard: --no-open is accepted as a documented no-op (issue #4 AC)", () => {
  it("boots successfully with --no-open present, exactly as without it", async () => {
    const options = baseOptions({ argv: ["--provider", "anthropic", "--no-open"] });
    const { ready, shutdown } = waitUntilBound(options);
    const donePromise = runDashboard(options);
    await ready;
    expect(options.stderrLines.some((line) => line.startsWith("Lohra dashboard:"))).toBe(true);
    shutdown();
    const code = await donePromise;
    expect(code).toBe(0);
  });
});

// Issue #222: `parseCommand` (arg-validation.ts) accepts `--flag=value` and
// unambiguous-prefix abbreviation, and `serve` already reads from
// `parsed.options` -- but `runDashboard` used to read the raw `argv` with
// its own `argv.indexOf(name)` helper, which never recognizes either form.
// `--host=203.0.113.5 --insecure` used to pass through unrefused: `option()`
// found no exact "--host" token, so `host` silently stayed the default
// 127.0.0.1 (loopback) and the #4 guard below never fired -- not a bypass
// (guard and bind read the same variable), but a command accepted with an
// effect different from what the CLI parser had already validated.
describe("runDashboard: --host=<v> and --port=<p> (equals form) and prefix abbreviation behave like the space form (issue #222)", () => {
  it("--host=<v> combined with --insecure is refused, exactly like --host <v>", async () => {
    const options = baseOptions({
      argv: ["--provider", "anthropic", "--insecure", "--host=203.0.113.5"],
    });
    // The --insecure/non-loopback refusal returns synchronously, before any
    // await or socket (dashboard.ts's own `runDashboard`, first check in the
    // body) -- no registerShutdownTrigger/sleep race to wait out here, same
    // as the two equivalent space-form tests above this file's #222 block.
    const code = await runDashboard(options);
    expect(code).toBe(2);
    const stderr = options.stderrLines.join("");
    expect(stderr).toContain("usage: lohra dashboard");
    expect(stderr).toContain("--host 203.0.113.5");
  });

  it("a unique prefix (--ho) for --host combined with --insecure is refused, too", async () => {
    const options = baseOptions({
      argv: ["--provider", "anthropic", "--insecure", "--ho", "203.0.113.5"],
    });
    const code = await runDashboard(options);
    expect(code).toBe(2);
    expect(options.stderrLines.join("")).toContain("--host 203.0.113.5");
  });

  it("--port=<p> (equals form) reaches the real bind attempt, mirroring --port <p>", async () => {
    // Issue #302 named this line as a network-state risk point during the
    // flaky-test characterization: the previous version found a free port
    // by listening on 0, reading the assigned port, and closing that probe
    // -- then reused the bare number for `--port=<p>`, a listen/close/reuse
    // TOCTOU window where another process could grab the same port first.
    // Kept the probe listening instead: passing its own already-bound port
    // straight into `--port=<p>` still proves the equals-form value reaches
    // `runDashboard`'s real bind (an EADDRINUSE refusal only happens if it
    // does), with no window where the port could be free-then-taken. The
    // refusal path returns before any await past the print (dashboard.ts),
    // so this needs no sleep/ready wait either -- `runDashboard` only
    // resolves once the outcome is settled.
    const occupying: Server = createServer();
    const occupiedPort = await new Promise<number>((resolvePromise, reject) => {
      occupying.once("error", reject);
      occupying.listen(0, "127.0.0.1", () => {
        const address = occupying.address();
        resolvePromise(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    const options = baseOptions({
      argv: ["--provider", "anthropic", `--port=${String(occupiedPort)}`],
    });
    delete (options as { port?: number }).port;
    const code = await runDashboard(options);
    expect(code).toBe(3);
    expect(options.stderrLines[0]).toBe(
      `Lohra dashboard: http://127.0.0.1:${String(occupiedPort)}\n`,
    );

    await new Promise<void>((resolvePromise) =>
      occupying.close(() => {
        resolvePromise();
      }),
    );
  });
});
