import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

const temporaryFile = (): { readonly directory: string; readonly path: string } => {
  const directory = mkdtempSync(join(tmpdir(), "lohra-socket-sentinel-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "events.jsonl") };
};

const records = (path: string): readonly unknown[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("serve socket sentinels", () => {
  it("arms inside Node and records a listen attempt", () => {
    const output = temporaryFile();
    const sentinel = resolve("scripts/parity/auth/socket-sentinel.cjs");
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>server.close())",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--require=${sentinel}`,
          LOHRA_SOCKET_SENTINEL: output.path,
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(records(output.path)).toEqual([{ kind: "armed" }, { kind: "listen" }]);
  });
});
