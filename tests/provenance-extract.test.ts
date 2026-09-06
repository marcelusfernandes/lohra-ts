import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractApprovedHeads,
  extractTableRows,
  parseProvenanceDocument,
  readProvenance,
} from "../scripts/provenance/extract.js";

const SHA_A = "5b2d62c65f282683609d5d3801b3bfaf4448aff4";
const SHA_B = "8901ea084e5797980650bd512f4fcd8fe251c952";
const root = resolve(import.meta.dirname, "..");

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

describe("docs/provenance.json ↔ docs/closeout.md (bidirectional)", () => {
  it(
    "has the exact same ticket/sha/result/status on both sides — a divergence on " +
      "either side fails this test (MUTATION_CAUSE:T158-provenance-bidirectional)",
    () => {
      const markdown = readFileSync(resolve(root, "docs", "closeout.md"), "utf8");
      const rows = extractTableRows(markdown);
      const document = readProvenance(resolve(root, "docs", "provenance.json"));

      expect(document.entries).toHaveLength(rows.length);
      expect(rows).toHaveLength(23);

      for (const [index, row] of rows.entries()) {
        const entry = document.entries[index];
        expect(entry, `MUTATION_CAUSE:T158-provenance-bidirectional:${row.ticket}`).toEqual({
          ticket: row.ticket,
          sha: row.sha,
          result: row.result,
          status: /^[0-9a-f]{40}$/u.test(row.sha) ? "approved" : "pending",
        });
      }
    },
  );
});

describe("readProvenance / parseProvenanceDocument (schema, fail-closed)", () => {
  it("reads the 22 approved + 1 pending entries from the real docs/provenance.json", () => {
    const document = readProvenance(resolve(root, "docs", "provenance.json"));
    expect(document.entries).toHaveLength(23);
    expect(document.entries.filter((entry) => entry.status === "approved")).toHaveLength(22);
    expect(document.entries.filter((entry) => entry.status === "pending")).toEqual([
      {
        ticket: "T22",
        sha: "EVIDENCE_BOUND_FINAL_SHA",
        result: "SHA exato vinculado no evidence index",
        status: "pending",
      },
    ]);
  });

  it("throws with the offending ticket when the ticket field is not T\\d{2}", () => {
    expect(() =>
      parseProvenanceDocument({
        entries: [{ ticket: "X00", sha: "a".repeat(40), result: "integrado", status: "approved" }],
      }),
    ).toThrow(/ticket must match/u);
  });

  it("throws when an approved entry has a sha that is not 40 hex chars", () => {
    expect(() =>
      parseProvenanceDocument({
        entries: [{ ticket: "T00", sha: "not-a-sha", result: "integrado", status: "approved" }],
      }),
    ).toThrow(/status "approved" requires a 40-hex sha/u);
  });

  it("throws when status is neither approved nor pending", () => {
    expect(() =>
      parseProvenanceDocument({
        entries: [{ ticket: "T00", sha: "a".repeat(40), result: "integrado", status: "unknown" }],
      }),
    ).toThrow(/status must be "approved" or "pending"/u);
  });

  it("allows a pending entry with a non-hex sha placeholder", () => {
    const document = parseProvenanceDocument({
      entries: [{ ticket: "T22", sha: "PLACEHOLDER", result: "pendente", status: "pending" }],
    });
    expect(document.entries).toEqual([
      { ticket: "T22", sha: "PLACEHOLDER", result: "pendente", status: "pending" },
    ]);
  });

  it("throws when the document has no entries array", () => {
    expect(() => parseProvenanceDocument({})).toThrow(/"entries" must be an array/u);
    expect(() => parseProvenanceDocument(null)).toThrow(/document must be an object/u);
    expect(() => parseProvenanceDocument({ entries: "not-an-array" })).toThrow(
      /"entries" must be an array/u,
    );
  });

  it("throws with the entry index when an entry is not an object", () => {
    expect(() => parseProvenanceDocument({ entries: [null] })).toThrow(
      /entries\[0\]:entry must be an object/u,
    );
  });

  it("fails closed with the file path when docs/provenance.json is missing", () => {
    expect(() => readProvenance(resolve(root, "docs", "does-not-exist.json"))).toThrow(
      /PROVENANCE_UNREADABLE/u,
    );
  });

  it("fails closed when the file is not valid JSON", () => {
    const invalidPath = join(mkdtempSync(join(tmpdir(), "provenance-")), "provenance.json");
    writeFileSync(invalidPath, "{ not json", "utf8");
    expect(() => readProvenance(invalidPath)).toThrow(/PROVENANCE_INVALID_JSON/u);
  });
});
