import process from "node:process";

import { HarnessError } from "./errors.js";
import { runTypeScriptProcess } from "./process.js";
import type { PreconditionRecord, PreconditionSpec } from "./types.js";

interface Limits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type TcpPortProbe = (host: string, port: number, limits: Limits) => boolean;

const probeSource = `
import net from "node:net";
const host = process.argv[1];
const port = Number(process.argv[2]);
const socket = net.createConnection({ host, port });
const finish = (code) => { socket.destroy(); process.exit(code); };
socket.once("connect", () => finish(10));
socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? 0 : 11));
socket.setTimeout(500, () => finish(12));
`;

function probeTcpPort(host: string, port: number, limits: Limits): boolean {
  const result = runTypeScriptProcess({
    executable: process.execPath,
    argv: ["--input-type=module", "-e", probeSource, host, String(port)],
    cwd: process.cwd(),
    environment: { PATH: "/usr/bin:/bin" },
    timeoutMs: Math.min(limits.timeoutMs, 1_000),
    maxOutputBytes: Math.min(limits.maxOutputBytes, 16_384),
  });
  if (result.exitCode === 10) {
    return true;
  }
  if (result.exitCode === 0) {
    return false;
  }
  throw new HarnessError(
    "PRECONDITION_PROBE_FAILED",
    `Could not determine whether tcp://${host}:${String(port)} is closed`,
  );
}

export function assertPreconditions(
  specs: readonly PreconditionSpec[],
  limits: Limits,
  probe: TcpPortProbe = probeTcpPort,
): readonly PreconditionRecord[] {
  return specs.map((spec) => {
    if (probe(spec.host, spec.port, limits)) {
      throw new HarnessError(
        "PRECONDITION_PORT_IN_USE",
        `Required closed port tcp://${spec.host}:${String(spec.port)} has a listener`,
      );
    }
    return { ...spec, status: "passed" as const };
  });
}
