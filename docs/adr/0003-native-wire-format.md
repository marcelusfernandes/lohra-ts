# ADR 0003: Native wire format — no byte compatibility with Python libraries

- Status: Accepted by owner
- Date: 2026-09-05
- Baseline: `9ebeafdf2f63c53b0932dd92ae8e129281de17cb` (`main` before phase 1 of #16)
- Supersedes: the byte-compatibility premise of `docs/parity-validation.md` and
  the "Oracle" header of ADR 0001 and ADR 0002 for any decision after this one
- Tracking: milestone "Superfície pública sem Python" — #16 (epic), #17 (phase
  1), #18 (phase 2), #19 (phase 3)

## Context

Until 2026-09-04 this repository was a drop-in port of the Python runtime. The
public surface was shaped byte for byte after Python libraries so that
consumers could not tell which runtime was behind the CLI:

- JSON output reproduces `json.dumps` — `", "` and `": "` separators, keys
  sorted by code point, lowercase `\uXXXX` escapes with surrogate pairs for
  non-BMP characters, `NaN`/`Infinity` literals (`src/serialization/python-json.ts`).
- Human-facing text reproduces `repr()` — `None`/`True`/`False`, single-quoted
  strings (`src/serialization/python-repr.ts`).
- CLI errors and help reproduce `argparse` (`src/cli.ts`, `src/cli/arg-spec.ts`,
  `src/cli/arg-validation.ts`, `src/commands/cron.ts`, `src/orchestration/limits.ts`).
- The OpenAI-compatible server reproduces the FastAPI/Pydantic 422 body and
  serves `/docs`, `/redoc`, `/openapi.json` in FastAPI's shape
  (`src/server/request-validation.ts`, `src/server/docs.ts`).
- The serializer tests use the real interpreter as the source of truth:
  `tests/python-json.test.ts:14` and `tests/python-repr.test.ts:8` spawn
  `python3 -c` and compare bytes.

On 2026-09-04 the owner ended the parity obligation (milestone "Setup:
processo independente") and, on the same day, ruled that a TypeScript
application must not carry a dependency on Python — neither an interpreter in
its test suite nor another language's libraries dictating the shape of its
output.

The runtime itself never executes Python in production; the mimicry is a pure
TypeScript reimplementation. The problem is the shape of the surface and the
test dependency it drags along.

## Decision

The lohra-ts public surface adopts its own wire format. Compatibility with
`json.dumps`, `repr()`, `argparse` and FastAPI/Pydantic output is no longer a
requirement, a test target, or a reason to keep code.

### JSON output

1. Serialization is `JSON.stringify`. Keys keep insertion order. No key sorting.
2. Non-ASCII characters are emitted as UTF-8 directly. No `\uXXXX` escaping
   beyond what `JSON.stringify` does for control characters.
3. Where output is indented today (`pythonJsonDumpsIndented`), indentation is
   two spaces (`JSON.stringify(value, null, 2)`). Where it is compact, it stays
   compact with `JSON.stringify`'s default separators.
4. Every byte the runtime emits as JSON must be accepted by a standards
   conformant JSON parser. `NaN`, `Infinity` and `-Infinity` are never
   serialized. A non-finite number reaching a serialization boundary is a fault
   with a cause (invariant 2: failure is never silent), handled at that
   boundary — the cron store already diagnoses non-finite schedules as
   permanently unreachable and must keep doing so without persisting them as
   bare literals.

### Human-facing text

5. Error messages, help text, and diagnostics are written for this product.
   They are not a byte contract with any library and may change without an
   ADR. Exit codes and HTTP status codes remain a contract.

### HTTP server

6. The 422 response body of `lohra serve` is defined by this repository and
   documented in the README. Whether `/docs`, `/redoc` and `/openapi.json`
   remain (backed by an OpenAPI document generated from this runtime) or are
   removed is decided in #18 and recorded there; either outcome is compatible
   with this ADR.

## What does not change

This ADR changes bytes and human text only. It does not change semantics.

- Field names, types and meaning of the `--json` envelope (`session_id`,
  `model`, `input`, `output`, `tool_calls`, `usage`, `usage_total`, `cost`,
  `stop_reason`, `completed`, `error`, `api_calls`, `session`).
- Exit codes of every command.
- The SQLite schema and file layout under `LOHRA_HOME` (`state.db`, profiles,
  `.env`, `cron/`, `mcp.json`). JSON columns are still JSON; only their
  formatting changes, and any reader that parses rather than compares bytes is
  unaffected.
- The gateway JSON-RPC method set and payload fields.
- The OpenAI-compatible request and response fields of `lohra serve`.

## Number fidelity is a separate concern and is kept

`src/serialization/python-json.ts` currently mixes two things. The mimicry
above goes. The following are wire fidelity toward provider APIs and toward
the runtime's own stores, and they survive independently of Python:

- Preserving float versus integer kind for values forwarded to providers
  (`fix(transports): preserve Anthropic tool float kinds`).
- Preserving integers outside the IEEE-754 safe range without loss
  (`fix(transports): preserve arbitrary JSON integers`).
- Parsing provider or store payloads that contain such values.

Phase 1 (#17) keeps these primitives, renames them without the `python`
prefix (the exact names are an implementation choice, e.g. `JsonFloat`,
`JsonInteger`, `parseJsonPreservingNumbers`), moves them out of any module
whose name suggests Python compatibility, and documents them as provider
fidelity. Their tests use golden values, not an interpreter.

Consumers of these primitives today, for the record of #17:
`src/transports/client.ts`, `src/transports/anthropic-messages.ts`,
`src/conversation/envelope.ts`, `src/cron/store.ts`, `src/cron/format.ts`,
`src/cli/arg-validation.ts`, `src/auth/store.ts`, `src/commands/cron.ts`,
`src/doctor/*.ts`, `src/gateway/rpc/frame.ts`, `src/gateway/session-service.ts`,
`src/orchestration/tools.ts`, `src/server/chat-format.ts`, `src/workflow/tool.ts`.

## Consequences

- `python3` disappears from the test suite. `npm test` runs with Node alone.
- The regression corpus captured from the Python oracle
  (`scripts/parity/scenarios/`, 180 fixtures) and every test comparing output
  digests become invalid by construction and are recaptured from lohra-ts
  itself in phase 3 (#19). The golden becomes "what this runtime decided", not
  "what Python did".
- The T22 closeout evidence (`scripts/parity/closeout/verify-evidence.ts`,
  `evidence-index.json`) documents a past state at specific SHAs and is not
  regenerated. It is retired as historical in #8 and #19.
- Any external consumer that compared bytes rather than parsing JSON breaks.
  None is known: the desktop app (`lohra/desktop/src/`) parses fields and does
  no text matching on errors; the `use-lohra` skill checks `error: null` and
  the exit code.
- While `~/.lohra` is shared with the Python runtime (the owner's current
  setup, profile `ts` for this runtime), JSON columns written by the two
  runtimes coexist in `state.db`. Both are valid JSON; parsers read both. Byte
  comparison across runtimes was never a supported operation and is not one
  now.

## Evidence required to retain this decision

- `grep -rn python3 tests src` returns nothing after #17.
- `npm test` passes on a machine or container with no Python on `PATH`.
- A real `lohra chat --json` and `lohra doctor --json`, parsed by
  `JSON.parse`, expose the same set of top-level keys before and after #17.
- One real `chat --json` consumed end to end by the `use-lohra` skill and one
  by the desktop app after #17.
- No serialized output contains the literals `NaN`, `Infinity` or `-Infinity`;
  the cron store's non-finite diagnostics still fire.

## Revisit triggers

Reopen this ADR before any of the following:

- an external consumer that depends on the exact bytes of any output, not on
  parsed fields;
- resuming cohabitation with the Python runtime in the same `LOHRA_HOME` with
  any reader that compares bytes across runtimes;
- reintroducing an interpreter of another language into the test suite or
  the build for any reason;
- changing envelope field names or semantics (that is a new ADR, not an
  amendment of this one);
- publishing the package to a registry, which freezes the format for
  consumers this repository does not control.
