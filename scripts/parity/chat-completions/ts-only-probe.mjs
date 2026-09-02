#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { ChatCompletionsTransport } from "../../../dist/transports/index.js";
import { pythonJsonDumps } from "../../../dist/serialization/python-json.js";

const id = "t07-user-content-defensive-copy";
const transport = new ChatCompletionsTransport();
const nested = { type: "text", text: "stable" };
const content = [nested];
const messages = [{ role: "user", content }];
const result = transport.buildKwargs({ model: "probe", messages });
const returned = result.messages[0]?.content;
if (Array.isArray(returned)) {
  returned.push({ type: "text", text: "mutated" });
  if (typeof returned[0] === "object" && returned[0] !== null) returned[0].text = "changed";
}
const observable = {
  arrayDistinct: returned !== content,
  nestedDistinct: Array.isArray(returned) && returned[0] !== nested,
  original: content,
};
const expected = {
  arrayDistinct: true,
  nestedDistinct: true,
  original: [{ type: "text", text: "stable" }],
};
const failures =
  pythonJsonDumps(observable) === pythonJsonDumps(expected)
    ? []
    : [{ field: "observable", expected, actual: observable }];
const projection = pythonJsonDumps(observable);
const evidence = {
  schemaVersion: 1,
  scenario: id,
  comparisonClass: "intentional-ts-only",
  observable,
  expected,
  failures,
  verdict: failures.length === 0 ? "match" : "divergent",
  projectionSha256: createHash("sha256").update(projection).digest("hex"),
};
const directory = resolve(".probe-evidence");
mkdirSync(directory, { recursive: true });
const path = resolve(directory, `${id}.json`);
writeFileSync(path, `${pythonJsonDumps(evidence)}\n`, { mode: 0o600 });
process.stdout.write(`${id} ${evidence.verdict} ${evidence.projectionSha256}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
