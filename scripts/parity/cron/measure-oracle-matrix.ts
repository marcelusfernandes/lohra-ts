#!/usr/bin/env node
// One-time diagnostic: measure the full 19-form x 6-operation matrix against
// the real pinned oracle, cell by cell, no inference from one cell to
// another. Not part of the harness proper -- this is the ground truth the
// contract's corrupted-forms tables (and the cli-bilateral scenarios) must
// be derived FROM, per the coordinator's instruction after E4.
import { CORRUPTION_FORMS, plantForm } from "./forms.js";
import { cleanup, jobsPathOf, materialize, readFileState, runOracleCron } from "./harness.js";

const OPERATIONS: { readonly op: string; readonly argv: readonly string[] }[] = [
  { op: "list", argv: ["list"] },
  { op: "add-valid", argv: ["add", "--name", "n1", "--prompt", "p1", "--interval", "5"] },
  { op: "add-invalid", argv: ["add", "--name", "", "--prompt", "p1", "--interval", "5"] },
  { op: "remove", argv: ["remove", "some-id"] },
  { op: "pause", argv: ["pause", "some-id"] },
  { op: "resume", argv: ["resume", "some-id"] },
];

function lastExceptionLine(stderr: string): string {
  const lines = stderr.trim().split("\n");
  const last = lines.at(-1) ?? "";
  return last.split(":")[0] ?? "";
}

const forms = CORRUPTION_FORMS.map((f) => f.name);
const rows: {
  readonly form: string;
  readonly op: string;
  readonly code: number;
  readonly stdout: string;
  readonly exceptionClass: string;
  readonly bytePreserved: boolean;
}[] = [];

for (const form of forms) {
  for (const operation of OPERATIONS) {
    const paths = materialize("oracle");
    try {
      plantForm(form, paths);
      const path = jobsPathOf(paths);
      const before = readFileState(path);
      const result = runOracleCron(operation.argv, paths);
      const after = readFileState(path);
      rows.push({
        form,
        op: operation.op,
        code: result.code,
        stdout: result.code === 0 ? result.stdout.trim() : "",
        exceptionClass:
          result.code !== 0 && result.stderr.includes("Traceback")
            ? lastExceptionLine(result.stderr)
            : "",
        bytePreserved: before.sha256 === after.sha256,
      });
    } finally {
      cleanup(paths);
    }
  }
}

// Print as a compact table, grouped by operation for readability.
for (const operation of OPERATIONS) {
  process.stdout.write(`\n=== ${operation.op} ===\n`);
  for (const row of rows.filter((r) => r.op === operation.op)) {
    process.stdout.write(
      `${row.form.padEnd(24)} code=${String(row.code).padEnd(3)} exc=${row.exceptionClass.padEnd(22)} preserved=${String(row.bytePreserved).padEnd(5)} stdout=${row.stdout.slice(0, 40)}\n`,
    );
  }
}

process.stdout.write(`\n${JSON.stringify(rows, null, 2)}\n`);
