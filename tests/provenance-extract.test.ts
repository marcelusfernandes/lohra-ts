import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractApprovedHeads } from "../scripts/provenance/extract.js";

const SHA_A = "5b2d62c65f282683609d5d3801b3bfaf4448aff4";
const SHA_B = "8901ea084e5797980650bd512f4fcd8fe251c952";

describe("extractApprovedHeads", () => {
  it("reads ticket and full SHA from a valid table, ignoring header and non-ticket rows", () => {
    const markdown = [
      "| Ticket | SHA aprovado | Resultado |",
      "| ------ | ------------ | --------- |",
      `| T00    | \`${SHA_A}\` | integrado |`,
      `| T01    | \`${SHA_B}\` | integrado; Evaluator 100/100 |`,
      "| Path   | Intenções    | Prova     |",
    ].join("\n");
    expect(extractApprovedHeads(markdown)).toEqual({
      approved: [
        { ticket: "T00", sha: SHA_A },
        { ticket: "T01", sha: SHA_B },
      ],
      skipped: [],
    });
  });

  it("reports a malformed SHA as skipped instead of dropping it silently", () => {
    const markdown = [
      `| T00 | \`${SHA_A}\` | integrado |`,
      "| T22 | `EVIDENCE_BOUND_FINAL_SHA` | SHA exato vinculado no evidence index |",
      "| T23 | `abc123` | short sha |",
    ].join("\n");
    const table = extractApprovedHeads(markdown);
    expect(table.approved).toEqual([{ ticket: "T00", sha: SHA_A }]);
    expect(table.skipped).toEqual([
      { ticket: "T22", raw: "EVIDENCE_BOUND_FINAL_SHA" },
      { ticket: "T23", raw: "abc123" },
    ]);
  });

  it("returns nothing for a document without the table", () => {
    expect(extractApprovedHeads("# no table here\n\nsome prose\n")).toEqual({
      approved: [],
      skipped: [],
    });
  });

  it("finds the 22 approved heads and the T22 placeholder in the real docs/closeout.md", () => {
    const real = readFileSync(resolve(import.meta.dirname, "..", "docs", "closeout.md"), "utf8");
    const table = extractApprovedHeads(real);
    expect(table.approved).toHaveLength(22);
    expect(table.approved[0]).toEqual({ ticket: "T00", sha: SHA_A });
    expect(table.skipped.map((row) => row.ticket)).toEqual(["T22"]);
  });
});
