// The 19-form corruption matrix (18 corrupted forms + `valid_one` as the
// control) named literally in contract decision 1/2 — the minimum inventory
// no scenario may substitute with family-sampling. Each form plants
// identical bytes on both the oracle's and the candidate's `home/cron/jobs.json`.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimePaths } from "./harness.js";

export type CorruptionClass = "silent" | "crash" | "ghost" | "control";

export interface CorruptionForm {
  readonly name: string;
  readonly class: CorruptionClass;
  /** The oracle exception type expected in stderr for the `crash` class (decision 1 table). */
  readonly oracleException?: string;
}

export const VALID_ONE_SEED =
  '{"jobs": [{"id": "aaaabbbbccccdddd", "name": "seed", "prompt": "p", "type": "interval", "value": 5, "enabled": true, "created_at": 0, "last_run_at": null}]}';

const NAN_LITERAL_CONTENT =
  '{"jobs": [{"id": "x", "name": "n", "prompt": "p", "type": "once", "value": NaN, "enabled": true, "created_at": 0, "last_run_at": null}]}';

/** `{"jobs": [<0xFF>]}` — 0xFF is never a valid UTF-8 lead byte in any position. */
const INVALID_UTF8_BYTES = Buffer.concat([
  Buffer.from('{"jobs": ['),
  Buffer.from([0xff]),
  Buffer.from("]}"),
]);

export const CORRUPTION_FORMS: readonly CorruptionForm[] = [
  { name: "valid_one", class: "control" },
  { name: "absent", class: "silent" },
  { name: "empty", class: "silent" },
  { name: "invalid_json", class: "silent" },
  { name: "truncated_json", class: "silent" },
  { name: "root_list", class: "silent" },
  { name: "root_string", class: "silent" },
  { name: "root_number", class: "silent" },
  { name: "root_null", class: "silent" },
  { name: "jobs_not_list", class: "silent" },
  { name: "jobs_missing", class: "silent" },
  { name: "jobs_null", class: "silent" },
  { name: "directory", class: "silent" },
  { name: "unreadable", class: "silent" },
  { name: "invalid_utf8", class: "crash", oracleException: "UnicodeDecodeError" },
  { name: "entry_number", class: "crash", oracleException: "TypeError" },
  { name: "entry_empty_object", class: "crash", oracleException: "KeyError" },
  { name: "entry_missing_enabled", class: "crash", oracleException: "KeyError" },
  { name: "nan_literal", class: "ghost" },
];

/** The 16 forms under candidate fail-closed (decision 3 / Emendas E2+E3):
 * all 18 corrupted forms minus `absent` (nothing at the path) and
 * `nan_literal` (structurally well-formed, semantically unreachable). */
export const FAIL_CLOSED_16 = CORRUPTION_FORMS.filter(
  (form) => form.class !== "control" && form.name !== "absent" && form.name !== "nan_literal",
).map((form) => form.name);

/** decision 2's four-way `add` asymmetry, by literal form name. */
export const ADD_DESTROYS_11 = [
  "empty",
  "invalid_json",
  "truncated_json",
  "root_list",
  "root_string",
  "root_number",
  "root_null",
  "jobs_not_list",
  "jobs_missing",
  "jobs_null",
  "unreadable",
];
export const ADD_PRESERVES_AND_APPENDS_4 = [
  "entry_number",
  "entry_empty_object",
  "entry_missing_enabled",
  "nan_literal",
];
export const ADD_CRASHES_BEFORE_WRITE_2 = ["invalid_utf8", "directory"];
export const ADD_CREATES_FROM_NOTHING_1 = ["absent"];

function contentOf(name: string): string {
  switch (name) {
    case "valid_one":
      return VALID_ONE_SEED;
    case "empty":
      return "";
    case "invalid_json":
      return "{nope";
    case "truncated_json":
      return '{"jobs": [{"id": "a"';
    case "root_list":
      return "[1, 2, 3]";
    case "root_string":
      return '"hello"';
    case "root_number":
      return "42";
    case "root_null":
      return "null";
    case "jobs_not_list":
      return '{"jobs": {"a": 1}}';
    case "jobs_missing":
      return '{"other": 1}';
    case "jobs_null":
      return '{"jobs": null}';
    case "entry_number":
      return '{"jobs": [42]}';
    case "entry_empty_object":
      return '{"jobs": [{}]}';
    case "entry_missing_enabled":
      return '{"jobs": [{"id": "x", "name": "n", "type": "interval", "value": 5}]}';
    case "nan_literal":
      return NAN_LITERAL_CONTENT;
    default:
      throw new Error(`T18_UNKNOWN_FORM:${name}`);
  }
}

/** Plants the named form's bytes at `home/cron/jobs.json` (or its absence/
 * special filesystem state) for one side's runtime paths. */
export function plantForm(name: string, paths: RuntimePaths): void {
  const dir = join(paths.home, "cron");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "jobs.json");
  if (name === "absent") return;
  if (name === "directory") {
    mkdirSync(path);
    return;
  }
  if (name === "unreadable") {
    writeFileSync(path, '{"jobs": []}');
    chmodSync(path, 0o000);
    return;
  }
  if (name === "invalid_utf8") {
    writeFileSync(path, INVALID_UTF8_BYTES);
    return;
  }
  writeFileSync(path, contentOf(name), "utf8");
}
