# ADR 0001: Reproduce the oracle's cross-server MCP shadowing

- Status: Accepted for T19 parity; security-debt disposition remains open
- Date: 2026-08-31
- Oracle: `16b4785d803ad0ca364a8a67346a04f949fbf592` (`lohra 0.0.11`)
- Candidate baseline: `233c999`
- Contract: Sprint 05 / T19 v2, decision 3 and assertions 12–16

## Context

MCP tool names are derived as `mcp_{sanitized_server}_{sanitized_tool}` while
the registry ownership label (`toolset`) retains the raw server name as
`mcp-{raw_server}`. Distinct raw server names can therefore produce the same
registered tool name.

The pinned Python oracle was measured with two servers, `github.com` and
`github_com`, each exposing `search`. Both declaration orders produced one
registered name, `mcp_github_com_search`. The last server registered served the
call, and no warning was emitted. This was verified by calling the tool and
reading `served-by:<server>` from its result, not inferred from registry state.

Overwriting also migrates the entry's `toolset` to the winner. The losing
server then sees no names in its own toolset, so deregistering it cannot remove
the entry. Only the winner can remove it.

## Decision

T19 reproduces this behavior exactly:

1. MCP-to-MCP name collisions silently overwrite the existing entry.
2. The last registered server owns and serves the resulting name.
3. The entry's toolset changes to the winning server's raw-name toolset.
4. Deregistering the losing server removes nothing; deregistering the winner
   removes the entry.
5. Intra-server collisions remain a different path: first declaration wins,
   the later declaration is skipped, and the exact bare warning is emitted.

This is an oracle-parity decision, not an endorsement of the behavior. The
silent shadow and the post-deregister survivor are recorded as product debts.
They remain escalated with T13/L22; T19 does not close or correct them by
analogy.

## Security consequences

- A later-declared MCP server can replace a tool exposed by an earlier server
  when both raw names sanitize to the same slug. Callers receive no warning.
- Tool ownership in the registry no longer identifies the original registrant.
- A losing server cannot remove the overwritten entry during its own
  deregistration.
- T19's separately approved `parent − E` rule is currently consumed by the
  agentic HTTP server, not by a public TS child turn (that path is still the
  T13 integration dependency). With today's 24 builtins it exposes the same
  five names as the former allow-list, but it is fail-open for future builtins.
  `serve` does not currently register MCP servers; if a future process combines
  both surfaces, a shadowed non-excluded MCP entry becomes eligible for HTTP
  exposure subject to the server's explicit `--tools` allow-list.

The callable-orphan end state is not reachable through the current public
product path: `MCPManager.refresh` has no product caller. This limits present
reachability but does not reduce the defect. Adding any product caller for
`refresh` expands the risk and requires a new security decision before merge.
Refresh also deregisters before calling `listTools`; if that call fails, the
server remains connected but has no registered tools (nuke without repave).
This is oracle parity and currently unreachable, but becomes a separate
availability/security debt as soon as a product caller is introduced.

## Boundaries and non-claims

- T19 fixtures only the MCP transport boundary and the provider upstream on
  loopback. Registration, dispatch, filtering, agent execution and request
  bytes are product code.
- The live MCP SDK path is not measured: real stdio/HTTP sessions, 30/120 second
  timeouts and subprocess/thread lifecycle remain code-only, not green by
  inference.
- No real credentials or external egress are used by the parity harness.
- T19 does not add a `refresh` caller or a real MCP SDK dependency.

## Evidence required to retain this decision

- Both cross-server declaration orders must be exercised through real
  `lohra chat` on oracle and candidate.
- The shadowed tool must be called; registry enumeration alone is insufficient.
- Both sides must show exactly one final name, the last server as owner, and no
  warning.
- A separate process-level lifecycle probe must show: losing toolset empty,
  losing deregister leaves the entry, winning deregister removes it.
- The intra-server pinned fixture (`fix`: `Do-Thing`, `do thing`, `other`) must
  preserve the warning/first-wins contrast.

## Revisit triggers

Reopen this ADR before any of the following:

- adding a product caller for `MCPManager.refresh`;
- changing MCP name sanitization or registry ownership labels;
- adding server trust tiers, namespace isolation or collision warnings;
- enabling a real MCP SDK path in the default installation;
- changing the child-tool visibility rule;
- registering MCP servers in a process that also serves agentic HTTP.
