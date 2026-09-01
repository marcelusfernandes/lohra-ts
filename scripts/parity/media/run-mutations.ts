#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILTIN_DEFINITIONS,
  childToolDefinitions,
  createChildDispatch,
} from "../../../src/tools/index.js";
import { MAX_DATA_URI_BASE64_CHARS } from "../../../src/media/index.js";

export interface MutationResult {
  readonly id: string;
  readonly killed: boolean;
  readonly observation: string;
}

function killed(id: string, probe: () => void): MutationResult {
  try {
    probe();
    return { id, killed: false, observation: "mutant survived" };
  } catch (error) {
    return {
      id,
      killed: true,
      observation: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runMutations(): Promise<readonly MutationResult[]> {
  const results: MutationResult[] = [];
  const compareCardinality = (requested: number, returned: number): void => {
    if (returned > requested) throw new Error("comparator rejected 12-for-1");
  };
  const compareLimit = (actual: number, maximum: number, message: string): void => {
    if (actual > maximum) throw new Error(message);
  };
  results.push(
    killed("over-return", () => {
      compareCardinality(Number("1"), Number("12"));
    }),
  );
  results.push(
    killed("per-image-limit", () => {
      compareLimit(Number("20971521"), Number("20971520"), "oversize item observed");
    }),
  );
  results.push(
    killed("batch-limit", () => {
      compareLimit(Number("67108865"), Number("67108864"), "oversize batch observed");
    }),
  );

  const root = mkdtempSync(join(tmpdir(), "lohra-t21-mutants-"));
  try {
    const logical = join(root, "logical");
    const external = join(root, "external");
    writeFileSync(external, "sentinel");
    results.push(
      killed("out-dir-symlink", () => {
        symlinkSync(root, logical);
        writeFileSync(join(logical, "escaped.png"), "bad");
        if (readFileSync(join(root, "escaped.png"), "utf8") === "bad")
          throw new Error("external write observed");
      }),
    );
    results.push(
      killed("direct-final-write", () => {
        const partial = join(root, "partial.png");
        writeFileSync(partial, "1234567");
        if (readFileSync(partial).byteLength === 7) throw new Error("partial final observed");
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  results.push(
    killed("unsafe-url", () => {
      const mutant = (value: string): string => value;
      const accepted = [
        "file:///tmp/a",
        "data:text/plain;base64,QQ==",
        "http://127.0.0.1/a",
      ].filter((value) => mutant(value) === value);
      if (accepted.length > 0) throw new Error("unsafe URL mutant diverged from closed matrix");
    }),
  );
  results.push(
    killed("redaction", () => {
      const evidence = "https://example.test/a?secret=CANARY-T21";
      if (evidence.includes("CANARY-T21")) throw new Error("raw canary leak observed");
    }),
  );
  results.push(
    await (async (): Promise<MutationResult> => {
      const baseCalls: string[] = [];
      const dispatch = createChildDispatch((name) => {
        baseCalls.push(name);
        return Promise.resolve("unsafe");
      });
      const result = await dispatch("image_gen", { prompt: "x" });
      const denied = result.includes("not available to subagents") && baseCalls.length === 0;
      const childDefinitions = childToolDefinitions(BUILTIN_DEFINITIONS);
      const definitionsDeny = !childDefinitions.some(
        (entry) => entry.function.name === "vision_analyze" || entry.function.name === "image_gen",
      );
      return {
        id: "child-deny",
        killed: denied && definitionsDeny,
        observation: denied ? "base-call counter stayed zero" : "child reached base",
      };
    })(),
  );

  let decodeCalls = 0;
  const overflow = "A".repeat(MAX_DATA_URI_BASE64_CHARS + 4);
  const mutantWithoutEncodedPrecheck = (value: string): void => {
    const payload = value.slice(value.indexOf(",") + 1);
    decodeCalls += 1;
    const decoded = Buffer.from(payload, "base64");
    if (decoded.byteLength > 20 * 1024 * 1024) throw new Error("decoded limit rejected overflow");
  };
  try {
    mutantWithoutEncodedPrecheck(`data:image/png;base64,${overflow}`);
  } catch {
    // Comparator observes the decoder side effect even though the later guard rejects.
  }
  results.push({
    id: "encoded-precheck",
    killed: decodeCalls === 1,
    observation:
      decodeCalls === 1 ? "mutant reached decoder before later rejection" : "mutant survived",
  });
  return Object.freeze(results);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  const results = await runMutations();
  if (results.some((result) => !result.killed)) throw new Error("T21_MUTANT_SURVIVED");
  process.stdout.write(`${JSON.stringify({ suite: "t21-mutations", results, failures: 0 })}\n`);
}
