# ADR 0002: Hybrid policy for hostile MCP inputs

- Status: Accepted by user for T19 contract v3
- Date: 2026-08-31
- Oracle: `16b4785d803ad0ca364a8a67346a04f949fbf592` (`lohra 0.0.11`)
- Candidate baseline for the finding: `d82fa55`
- Contract: Sprint 05 / T19 v3, Emenda E2 and assertions 27–34

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
7. `args` and `env` preserve the oracle's Python container construction at the
   fixture boundary instead of silently dropping non-string values.

Items 3, 5 and 6 are deliberate fail-closed divergences. Items 1, 2, 4 and 7
align the pinned oracle. Public error class and non-empty cause are fixed;
runtime-specific exception names and wording are not.

## Atomicity and interaction with ADR 0001

Tool-name validation happens before the first call to `ToolRegistry.register`.
Otherwise a valid prefix of a rejected batch could shadow another server and
survive under ADR 0001's last-wins behavior. For a rejected batch, zero tools
from that server survive. ADR 0001 remains unchanged for fully valid batches.

Config validation happens before session creation or registry access. One
invalid server spec aborts the complete config set, matching the existing
config error boundary.

## Accepted security debt: `args` and `env`

The user explicitly chose oracle alignment for malformed `args`/`env`, despite
the Evaluator's recommendation to reject them. This is acceptable only because
T19 does not enable a live MCP SDK and the fixture never spawns a process.

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
  public result envelopes, placeholder spellings and config observed by the MCP
  fixture on both oracle and candidate.
- `[chat-bilateral]` records deliberate divergences for invalid `content` and
  `url`/`command`, and proves invalid tool-name batch rejection with a valid
  neighboring server.
- Process/unit tests are mutation-kill support for atomicity and causes; they do
  not replace the public traversal.
- No real credentials, external egress or live MCP subprocess are permitted.
