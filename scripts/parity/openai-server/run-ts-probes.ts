#!/usr/bin/env node
// T11 [probe-complementar]: 6 structural/functional probes against the
// candidate's own public exports and source — never a substitute for
// [socket-bilateral] evidence (which proves the two real processes agree
// on the wire), these prove INTERNAL invariants a bilateral diff alone
// cannot observe: that the timing-safe compare is genuinely non-`===`,
// that relay/agentic wiring picks the right iteration cap from the real
// composition root, that there's exactly one tool loop, that the two
// serializers are genuinely different functions, that client tool fields
// are structurally unreachable before the runtime, and that the scrub
// mechanism actually refuses a write rather than silently allowing one.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { AGENTIC_MAX_ITERATIONS, RELAY_MAX_ITERATIONS } from "../../../src/server/agentic.js";
import { authorized, timingSafeStringEqual } from "../../../src/server/auth.js";
import { jsonStringifyPythonNumbers, pythonJsonDumpsInsertionOrder } from "../../../src/serialization/python-json.js";
import { evidenceRoot, registerScrubCanary, writeEvidence } from "./harness.js";

const root = resolve(import.meta.dirname, "../../..");
mkdirSync(evidenceRoot, { recursive: true });
const results: Record<string, unknown> = {};
let failures = 0;

function record(id: string, pass: boolean, detail: unknown): void {
  results[id] = { pass, detail };
  if (!pass) failures += 1;
}

// 1. t11-auth-timing-safe-mutant-killed (assertion 18): the compare is a
// genuine timing-safe primitive over fixed-size operands, not `===` — a
// mutant swap would make this source-grep fail even if the functional
// behavior happened to still look right.
{
  const authSource = readFileSync(resolve(root, "src/server/auth.ts"), "utf8");
  const usesTimingSafePrimitive = authSource.includes("timingSafeEqual");
  const functionalOk =
    timingSafeStringEqual("secret-key", "secret-key") &&
    !timingSafeStringEqual("secret-key", "secret-keyX") &&
    !timingSafeStringEqual("a", "ab") &&
    authorized("Bearer secret-key", "secret-key") &&
    !authorized("Bearer wrong", "secret-key") &&
    !authorized(undefined, "secret-key") &&
    authorized("anything", null); // null key = --insecure semantics: any Authorization passes.
  record("t11-auth-timing-safe-mutant-killed", usesTimingSafePrimitive && functionalOk, {
    usesTimingSafePrimitive,
    functionalOk,
  });
}

// 2. t11-iteration-wiring-relay-8-agentic-90 (assertion 52): the real
// composition root (src/commands/serve.ts) picks RELAY_MAX_ITERATIONS by
// default and AGENTIC_MAX_ITERATIONS only when the --tools allow-list is
// non-empty — checked against the ACTUAL wiring text, not just the
// constants' own values (which a mutant could leave untouched while
// swapping which branch uses which).
{
  // The whole point is a RUNTIME check against these exported constants; a
  // mutant that changes their value is exactly what this must catch, even
  // though tsc's literal-type narrowing makes it look statically redundant
  // against the current, correct source.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const constantsOk = RELAY_MAX_ITERATIONS === 8 && AGENTIC_MAX_ITERATIONS === 90;
  const serveSource = readFileSync(resolve(root, "src/commands/serve.ts"), "utf8");
  const defaultsToRelayOk = /let maxIterations = RELAY_MAX_ITERATIONS/u.test(serveSource);
  const allowlistBlock = /if \(allowedNames\.length > 0\) \{[\s\S]*?maxIterations = AGENTIC_MAX_ITERATIONS;[\s\S]*?\}/u.test(
    serveSource,
  );
  record("t11-iteration-wiring-relay-8-agentic-90", constantsOk && defaultsToRelayOk && allowlistBlock, {
    constantsOk,
    defaultsToRelayOk,
    allowlistBlock,
    relayValue: RELAY_MAX_ITERATIONS,
    agenticValue: AGENTIC_MAX_ITERATIONS,
  });
}

// 3. t11-single-runtime-no-server-loop (assertion 69): the tool/turn loop
// (`for (let iteration`) exists exactly once, in conversation/runtime.ts —
// server/ files are adapters/projections and never duplicate it.
{
  const runtimeSource = readFileSync(resolve(root, "src/conversation/runtime.ts"), "utf8");
  const runtimeLoops = (runtimeSource.match(/for \(let iteration/gu) ?? []).length;
  const serverFiles = [
    "src/server/service.ts",
    "src/server/chat-handler.ts",
    "src/server/responses-handler.ts",
    "src/server/http-app.ts",
    "src/server/agentic.ts",
    "src/server/chat-format.ts",
    "src/server/responses-format.ts",
  ];
  const serverLoopCounts = Object.fromEntries(
    serverFiles.map((path) => {
      const source = readFileSync(resolve(root, path), "utf8");
      return [path, (source.match(/for \(let iteration/gu) ?? []).length];
    }),
  );
  const serverHasNoLoops = Object.values(serverLoopCounts).every((count) => count === 0);
  record("t11-single-runtime-no-server-loop", runtimeLoops === 1 && serverHasNoLoops, {
    runtimeLoops,
    serverLoopCounts,
  });
}

// 4. t11-two-serializer-mutants-killed (assertions 9/29/36): non-stream
// bodies (jsonStringifyPythonNumbers, wired through chatCompletionBody)
// and SSE frames (pythonJsonDumpsInsertionOrder, wired through
// sseEvent/responsesSse) are genuinely DIFFERENT encoder functions — a
// mutant that merges them (either direction) is caught functionally: the
// two outputs for the SAME object must differ (spacing), not just the
// source-level wiring.
{
  const sample = { a: 1, b: "x", c: [1, 2] };
  const compact = jsonStringifyPythonNumbers(sample);
  const spaced = pythonJsonDumpsInsertionOrder(sample);
  const outputsDifferOk = compact !== spaced && compact === '{"a":1,"b":"x","c":[1,2]}' && spaced.includes(": ");
  const httpIoSource = readFileSync(resolve(root, "src/server/http-io.ts"), "utf8");
  const chatFormatSource = readFileSync(resolve(root, "src/server/chat-format.ts"), "utf8");
  const responsesFormatSource = readFileSync(resolve(root, "src/server/responses-format.ts"), "utf8");
  const nonStreamWiredToCompactOk =
    httpIoSource.includes("chatCompletionBody") && chatFormatSource.includes("jsonStringifyPythonNumbers");
  const sseWiredToSpacedOk =
    chatFormatSource.includes("pythonJsonDumpsInsertionOrder") && responsesFormatSource.includes("pythonJsonDumpsInsertionOrder");
  record(
    "t11-two-serializer-mutants-killed",
    outputsDifferOk && nonStreamWiredToCompactOk && sseWiredToSpacedOk,
    { outputsDifferOk, nonStreamWiredToCompactOk, sseWiredToSpacedOk, compact, spaced },
  );
}

// 5. t11-client-tool-fields-never-reach-runtime (assertion 51, structural
// half — the wire-level negative is proven bilaterally by
// t11-client-tools-negative-discard). Neither request-body validator nor
// either handler ever reads a "tools"/"tool_choice" key from the client's
// body — a client-supplied tool definition is structurally unreachable
// before the runtime, not merely dropped by convention.
{
  const filesToCheck = [
    "src/server/request-validation.ts",
    "src/server/chat-handler.ts",
    "src/server/responses-handler.ts",
  ];
  const findings = Object.fromEntries(
    filesToCheck.map((path) => {
      const source = readFileSync(resolve(root, path), "utf8");
      return [path, /tools|tool_choice/u.test(source)];
    }),
  );
  const noneReferenceToolFieldsOk = Object.values(findings).every((found) => !found);
  record("t11-client-tool-fields-never-reach-runtime", noneReferenceToolFieldsOk, findings);
}

// 6. t11-scrub-planted-canaries (assertion 8): a deliberately planted
// canary that survives redaction must cause writeEvidence to throw
// non-zero, never silently pass through to disk.
{
  const canary = "T11_PLANTED_SCRUB_CANARY_MUST_NEVER_SURVIVE";
  registerScrubCanary(canary);
  let threw = false;
  let threwWithRightId = false;
  try {
    writeEvidence("t11-probe-scrub-canary-plant", { secret: canary });
  } catch (error) {
    threw = true;
    threwWithRightId = error instanceof Error && error.message.includes("T11_SCRUB_HIT") && error.message.includes(canary);
  }
  record("t11-scrub-planted-canaries", threw && threwWithRightId, { threw, threwWithRightId });
}

const digest = createHash("sha256")
  .update(
    Object.entries(results)
      .map(([id, value]) => `${id}=${createHash("sha256").update(JSON.stringify(value)).digest("hex")}\n`)
      .join(""),
  )
  .digest("hex");

writeFileSync(
  resolve(evidenceRoot, "probe-complementar.json"),
  `${JSON.stringify({ suite: "t11-openai-server-probe-complementar", results, digest }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify({ suite: "t11-openai-server-probe-complementar", probes: Object.keys(results).length, failures, digest, results })}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
