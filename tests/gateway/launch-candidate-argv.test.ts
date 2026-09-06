// Issue #132: o wrapper `tsx/dist/cli.mjs` cria um processo intermediário
// que, ao repassar SIGINT ao filho real, faz um handshake IPC (~30ms+30ms
// de ack); sob carga essa janela estoura, o wrapper SIGKILLa o filho e sai
// 128+2=130 (diagnóstico da PR #131). Este teste prende a forma de
// lançamento em si (o argv passado a `spawn`), sem depender de um boot real
// — mocka `node:child_process` para que a asserção seja rápida e
// determinística, e não duplique o teste de subprocesso real em
// `launch-candidate.test.ts`.
import { EventEmitter } from "node:events";

import { afterEach, expect, it, vi } from "vitest";

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]): FakeChildProcess => spawnMock(...args),
}));

class FakeChildProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    return true;
  }
}

afterEach(() => {
  vi.resetAllMocks();
});

it("launches the candidate via --import tsx, never through tsx's cli.mjs wrapper", async () => {
  const { launchCandidateDashboard } =
    await import("../../scripts/parity/gateway/launch-candidate.js");

  const fakeChild = new FakeChildProcess();
  spawnMock.mockReturnValue(fakeChild);

  const resultPromise = launchCandidateDashboard({
    argv: ["--provider", "anthropic", "--insecure"],
    env: { HOME: "/tmp/does-not-matter" },
    cwd: "/tmp",
  });

  // `spawn` and the stderr listener are attached synchronously before the
  // function's only `await`, so it is safe to emit the boot line right
  // after calling it.
  fakeChild.stderr.emit("data", Buffer.from("Lohra dashboard: http://127.0.0.1:55775\n"));

  const process_ = await resultPromise;
  expect(process_.port).toBe(55_775);

  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
  expect(command).toBe(process.execPath);
  expect(args.some((arg) => arg.includes("tsx/dist/cli.mjs"))).toBe(false);
  expect(args).toContain("--import");
  expect(args.some((arg) => arg.includes("src/cli.ts"))).toBe(true);
});
