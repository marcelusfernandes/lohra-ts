# ADR 0005: Mid-flight abort of an in-flight model stream

- Status: Accepted by owner (2026-09-13, issue #465, comment
  https://github.com/marcelusfernandes/lohra-ts/issues/465#issuecomment-5645856763)
- Date: 2026-09-13
- Baseline: `f631a2ba03c83c2b4868b648b0818eeefb30bc64` (`main`, branch point of
  this PR)
- Supersedes: the "never a mid-flight abort of an upstream call in progress"
  doctrine (contract assertion 40, parity era) declared at
  `src/orchestration/core.ts:99-103` (the `ChildRunner` contract doc) and
  again at `src/orchestration/core.ts:381-390` (the `shutdown()` drain doc).
  Issues #465 and #490 cite this doctrine at `core.ts:68-71`; that line range
  has shifted since those issues were written and today holds the
  `SpawnConfig.wrapDispatch` doc (`core.ts:62-77`), not the doctrine text.
  The two ranges above are where the doctrine text actually lives as of this
  ADR's baseline.
- Tracking: this decision is issue #465, milestone 11 ("Rotas, cache e
  artefatos: contratos do DAG" — exit criterion: "ADR do abort de stream
  aprovado ou recusado explicitamente"). Implementation is epic #490,
  milestone 16 ("Abort de stream em voo"); per #490's own description,
  sub-issues are created when that milestone opens, after milestone 15 — not
  decomposed by this ADR or this PR.

## Context

`src/orchestration/core.ts:99-103` and `src/orchestration/core.ts:381-390`
both declare that a leaf's `AbortSignal` is a cooperative, checked-between-
iterations mechanism — the same one behind the parent's own Ctrl-C — "never a
mid-flight abort of an upstream call in progress" (contract assertion 40, the
parity era). The cooperative checks live at `src/conversation/runtime.ts:373`
and `:409` (`signalAborted(signal)`, throwing `ConversationCancelledError`
before the next provider call is issued, never during one already in
flight); the trigger for a single leaf's signal is
`src/orchestration/core.ts:377` (`entry.abortController.abort()`).

Concretely, today: a cancel, a steer-triggered interrupt, or a timeout that
fires while a model stream is being read waits for that stream to finish,
discards the result, and the run is charged for every token the provider
generated. The signal exists on the request but does not reach the streaming
call:

- `src/conversation/provider-model.ts:29` — `AnthropicMessagesModel.complete`'s
  streaming branch calls `this.client.stream(kwargs, {...})` with no
  `request.signal`; the non-streaming branch one line below (`:30`) does pass
  `request.signal` into `.create()`.
- `src/conversation/chat-completions-model.ts:23` — the same pattern for
  `ChatCompletionsModel.complete`: the streaming branch drops `request.signal`,
  the non-streaming branch on `:24` keeps it.
- `src/transports/client.ts:296` — `ChatCompletionsClient.stream` does not
  declare a `signal` parameter at all, so there is nothing for a caller to
  pass even if it wanted to.
- `src/transports/client.ts:472` — `AnthropicMessagesClient.stream` likewise
  declares no `signal` parameter, even though its private `request()` helper
  (`:494`) already accepts and forwards one to the HTTP layer.
- By contrast, `ResponsesClient.stream` (`client.ts:571-575`) does accept and
  forward a `signal`, and `ResponsesModel.complete` (`provider-model.ts:44-55`)
  passes `request.signal` into it. Whether that signal actually interrupts an
  in-flight body read in `NativeChatHttpPort` today is not verified by this
  ADR and is not claimed here either way.

The ledger already has the shape this decision extends, not a shape it
invents: `leaf.failed` is an existing audit event
(`src/workflow/audit-runtime.ts:401-407` for a failed/cancelled collect result,
`:413-417` for a `wait: true` collect that times out, `:425` for an explicit
`cancel()`), and it already carries `usage_uncertain` — the ledger-level
mirror of the leaf-level `usageUncertain` marker
(`src/orchestration/core.ts:41-46`: zero counters that must never be confused
with a turn that genuinely spent zero tokens). What `cancel()` writes today
(`audit-runtime.ts:425`) is `{status: "cancelled", reason: "cancelled"}` —
no `error_kind`, no notion of partiality.

`turn.completed` is emitted once per turn at `src/conversation/runtime.ts:588`
(declared in `src/conversation/types.ts:117`). The existing cooperative
checks (`runtime.ts:373`, `:409`) already keep a between-iteration cancel from
reaching that emission; this ADR extends the same guarantee to a turn
aborted while a provider call is literally in flight, which those checks do
not cover today.

`src/transports/error-kinds.ts:19-20` lists `"timeout"` and `"cancelled"` as
two distinct, closed kinds.

ADR 0003 ended the byte-parity obligation but is a wire-format decision, not
a behavior one; it does not govern whether an in-flight call may be
interrupted. Issue #465 asked the owner to accept or reject the mid-flight
abort doctrine explicitly, per ADR 0004 item 9 (accepting an ADR is a human
gate — silence is not approval).

## Decision

**Accepted** (owner, 2026-09-13, issue #465). In-flight abort of a model
stream is now permitted for the three triggers the owner named: cancel,
steer, and timeout. Today the signal is fired by `cancel()`
(`src/orchestration/core.ts:377`, `entry.abortController.abort()`), which the
engine's own leaf-timeout follow-up also reaches
(`src/workflow/audit-runtime.ts:409-411`: a `wait: true` collect that comes
back `"running"` is treated as a timeout and the engine calls `cancel(id)`),
and by `shutdown()` (`core.ts:103`, "shutdown() is this signal's only trigger
today"). Steer today is inbox delivery via `drainMessages`
(`core.ts:14-26`, `conversation/runtime.ts:374-385`), not an abort signal;
how steer becomes an in-flight abort trigger is a definir na decomposição do
#490. Rules, as stated in issue #465 and confirmed in the owner's comment on
that issue:

1. A turn aborted while a provider call is in flight never becomes
   `turn.completed`.
2. Partial tokens are estimated and marked as partial in accounting — not
   silently folded into, or confused with, a turn that measured zero tokens
   for real (same posture as `usageUncertain`, `core.ts:41-46`).
3. The ledger records `leaf.failed` with `error_kind: "cancelled"` and
   `partial: true`.
4. `src/orchestration/core.ts:99-103` and `:381-390` stop asserting "never a
   mid-flight abort" and cite this ADR instead. That is a code change and
   lands with the implementation epic (#490), not with this PR — this PR
   touches only this file.

A definir na decomposição do #490 — not decided by the owner's comment or by
this ADR:

- How partial tokens are estimated; no formula is fixed here.
- The `error_kind` for a timeout-triggered abort: the owner's comment states
  `error_kind: "cancelled"` literally for all three triggers, but
  `error-kinds.ts:19-20` already has a separate `"timeout"` kind. Whether a
  timeout-triggered in-flight abort reuses `"cancelled"` or gets its own
  kind is a definir na decomposição do #490.
- Whether `shutdown()`'s drain (`core.ts:381-390`, today "drains, never
  abandons") also starts aborting in flight, or keeps waiting for every
  child to finish while only cancel/steer/timeout gain the new behavior —
  the owner's rule names cancel, steer and timeout, not shutdown; a definir
  na decomposição do #490.
- Which streaming client(s) need new plumbing versus which already thread a
  signal that just needs verifying: `ResponsesClient` already forwards a
  `signal` into the HTTP layer (`client.ts:571-575`); the Anthropic and Chat
  Completions clients currently do not, at any of the four call sites listed
  in Context above. #490 names this as its own first sub-item (S1, a fake
  stream, no network).

## Consequences

Positive:

- A cancel becomes bounded by how fast the abort signal propagates, not by
  how long the response would have taken to finish.
- No charge for tokens the provider generates after the abort fires, beyond
  the partial ones already produced (which are counted and marked partial,
  not discarded and not silently un-counted).

Negative / risks:

- Estimating partial tokens is inherently approximate: an aborted stream
  never gets a final `usage` frame from the provider, so the estimate can
  under- or over-count relative to what the provider actually billed.
- The Anthropic and Chat Completions clients need new plumbing to actually
  interrupt an in-flight request — today neither `.stream()` method even
  accepts a `signal` (`client.ts:296`, `:472`). Until #490 lands, "in-flight
  abort is permitted" is a decision, not yet an observed behavior.
- The audit allow-list gains an additive field, `partial`, on `leaf.failed`.
  Every reader of that event (`docs/workflow-audit.md`, `steer-tool.ts`
  queries, any dashboard) needs to tolerate a field it doesn't expect yet —
  the same additive-envelope posture already recorded in
  `docs/decisions/2026-09-12-envelope-delegate-aditivo.md`.

What does not change:

- ADR 0003 (native wire format) stands. This is a behavior decision, not a
  byte-format one; no new obligation to reproduce Python bytes follows from
  it.
- Cooperative, between-iteration cancellation (`runtime.ts:373`, `:409`,
  triggered by `core.ts:377`) keeps working exactly as it does today for a
  turn that is not mid-provider-call. This ADR only extends abort to the
  in-flight case.

## Implementation

Tracked as epic #490 ("abort de stream em voo — clientes streaming honram o
AbortSignal, turno parcial marcado, ledger leaf.failed {cancelled, partial}"),
milestone 16 ("Abort de stream em voo"). Per #490's own text, sub-issues are
created "na abertura da milestone" — after milestone 15 closes — not
decomposed by this ADR. #490's suggested (not yet committed) breakdown:
streaming clients honoring the signal, verified with a no-network fake
stream; partial-token accounting plus `partial` in the audit allow-list;
`cancel`/`steer`/timeout threading the signal end to end with the engine
handling the partial turn; docs plus the `core.ts` comment update and a
mutation-testing slice over the abort path.

This ADR's own PR is docs class (ADR 0004 item 7: every file under
`docs/**`) and touches only this file. Any change to `src/` — including the
`core.ts:99-103` / `:381-390` comment update named in Decision item 4 — is out
of scope here and belongs to #490.
