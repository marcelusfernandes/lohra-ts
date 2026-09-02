# ADR 0002: Hybrid policy for hostile MCP inputs

- Status: Accepted by user for T19 contract v4
- Date: 2026-08-31
- Oracle: `16b4785d803ad0ca364a8a67346a04f949fbf592` (`lohra 0.0.11`)
- Candidate baseline for the finding: `d82fa55`
- Contract: Sprint 05 / T19 v4, Emendas E2/E3 and assertions 27–34

## Context

The independent security review measured eight hostile JSON shapes outside the
T19 v2 goldens. Some candidate divergences silently discarded information or
converted an error into success; others rejected malformed network/process or
result structures more safely than the oracle.

ADR 0001 does not govern these cases. It is restricted to valid MCP batches,
cross-server name shadowing and deregistration lifecycle debt.

## Decision

Use a hybrid policy:

1. Preserve truthy non-string tool descriptions in the upstream schema.
2. A truthy non-string text block fails through the public tool-error envelope;
   it never becomes successful empty content.
3. A non-array result `content` remains fail-closed with an observable cause.
4. Non-text placeholder values use Python spelling (`None`, `True`, `False`).
5. A truthy non-string tool name rejects that server's complete tool batch
   before any registry mutation. A valid neighboring server still connects.
6. A truthy non-string `url` or `command` rejects the complete config set with
   a cause that identifies the server and field.
7. `args` accepts only JSON strings/arrays. `env` accepts JSON objects or
   iterable pairs whose keys are non-ambiguous strings or `null` (coerced to
   `"null"`), with no duplicate after coercion. Accepted mappings use a
   null-prototype dictionary; `__proto__` is an enumerable own property.
8. Shapes that `Record<string, unknown>` cannot represent without changing
   Python identity/order are rejected fail-closed with an explicit cause:
   boolean/number/array/object keys, canonical array-index strings
   (`0..4294967294` in canonical decimal form), and duplicates after coercion.

Items 3, 5, 6 and 8 are deliberate fail-closed divergences. Items 1, 2 and 4
align the pinned oracle universally within their stated shapes; item 7 aligns
only the versioned representable domain. Public error class and non-empty cause
are fixed; runtime-specific exception names and wording are not.

## Atomicity and interaction with ADR 0001

Tool-name validation happens before the first call to `ToolRegistry.register`.
Otherwise a valid prefix of a rejected batch could shadow another server and
survive under ADR 0001's last-wins behavior. For a rejected batch, zero tools
from that server survive. ADR 0001 remains unchanged for fully valid batches.

Config validation happens before session creation or registry access. One
invalid server spec aborts the complete config set, matching the existing
config error boundary.

## Versioned representation boundary: `args` and `env`

The initial v3 decision claimed general Python `dict()` construction. Security
review demonstrated that a JavaScript `Record` plus JSON serialization cannot
preserve all of Python's key identity and ordering: integer-index ordering,
`True == 1` collisions, numeric lexical spelling, and duplicate JSON keys after
coercion have no lossless `Record` representation. The user chose to retain the
public `Record<string, unknown>` interface and version the claim down to the
representable domain above, rather than introduce a custom ordered multimap.

This boundary fails closed rather than silently normalizing. Causes identify
the server, field and (for pair input) entry/key class. It is acceptable only
because T19 does not enable a live MCP SDK and the fixture never spawns a
process.

Reopen this ADR before any of the following:

- enabling `@modelcontextprotocol/sdk` or another live MCP connector;
- passing `args`/`env` to `spawn`, `exec` or a shell;
- allowing MCP config from an untrusted or remote source;
- adding coercion/validation inside a connector that would change the observed
  config shape.

The re-review must choose and document a typed execution-boundary validation;
silent discard remains prohibited.

## Evidence

- `[chat-bilateral]` captures raw descriptions in the real upstream request,
  public result envelopes, placeholder spellings and accepted config observed
  by the MCP fixture on both oracle and candidate. It also records the deliberate
  public fail-closed divergence for ambiguous `args`/`env` shapes.
- `[chat-bilateral]` records deliberate divergences for invalid `content` and
  `url`/`command`, and proves invalid tool-name batch rejection with a valid
  neighboring server.
- Process/unit tests are mutation-kill support for atomicity, null-prototype
  construction, collision detection and explicit causes; they do not replace
  the public traversal.
- No real credentials, external egress or live MCP subprocess are permitted.
