// Issue #589 (épico #575 P13): delivers pending `operator_notices`
// (src/state/notices-repository.ts) into the turn itself, so a model that
// never calls `workflow_notices` still sees what happened. Claim/format
// live here — never in `src/conversation/runtime.ts`, already at CLAUDE.md's
// 800-line cap — which only ever calls the `TurnNoticesPort` this factory
// returns (`src/conversation/types.ts`).
//
// Only `global` and `session:<id>` are ever claimed here — NEVER `run:<id>`.
// A workflow run's id (`workflow_run_state.run_id`) and a chat session's id
// are disjoint namespaces (épico #575 P13 audit): claiming `run:*` by
// lineage would let a session ack a workflow-run pause it never caused. The
// route-fault eval scenario the issue describes needs a run→session link
// this file does not have — tracked as a follow-up, not solved here.
import type { NoticeKind } from "../state/notices-repository.js";
import type { TurnNoticesClaim, TurnNoticesPort } from "../conversation/types.js";
import { classifyProviderError } from "../transports/errors.js";

export const NOTICE_OVERLAY_MAX_CHARS = 4096;
const OVERLAY_BEGIN = "OPERATOR NOTICES (not the user speaking):";
const OVERLAY_END = "END OPERATOR NOTICES";
const GLOBAL_SCOPE = "global";
const SESSION_SCOPE_PREFIX = "session:";
// Issue #608 (menor #5): both markers above share this substring — a
// `row.message` that contains it VERBATIM (a provider error message, a
// tool's own error text, anything not authored by this file) could forge
// the block's end from the model's point of view, letting whatever follows
// it be read as ordinary content instead of an operator notice. A
// zero-width space (U+200B) breaks the exact match while staying visually
// identical; the two REAL markers this file emits never contain it.
const MARKER_KEYWORD = "OPERATOR NOTICES";
// Issue #652 (veredito PR #635, reason 3): escaped, not a raw U+200B in the
// source — the character itself is invisible in most editors/diffs; the
// escape is legible and behaves identically (`String.prototype.split`/
// `join` on a code point, same as before).
const ZERO_WIDTH_SPACE = "\u200B";
function escapeMarkerKeyword(message: string): string {
  return message.split(MARKER_KEYWORD).join(`OPERATOR${ZERO_WIDTH_SPACE}NOTICES`);
}

export interface NoticeRow {
  readonly id: number;
  readonly scope: string;
  readonly kind: string;
  readonly message: string;
}

export interface NoticesOverlayRepository {
  list(query: {
    readonly scope?: string;
    readonly includeAcked?: boolean;
    readonly limit?: number;
  }): { readonly notices: readonly NoticeRow[] };
  ack(id: number, actor: string, now?: number): boolean;
  append(
    scope: string,
    input: { readonly kind: string; readonly message: string },
  ): NoticeRow | null;
}

export interface LineageSource {
  lineageRootToTip(sessionId: string): readonly string[];
}

/** Reads every PENDING notice addressed to `owners` (a session's own id plus
 * every ancestor `lineageRootToTip` returns) and the `global` scope.
 * Read-only: nothing is locked or marked claimed on disk, so a caller that
 * never acks the rows it gets back leaves them exactly as pending as before
 * — AC3's "release on failure" falls out of this for free, no separate
 * release call needed. */
export function claimLineageNotices(
  repo: NoticesOverlayRepository,
  owners: readonly string[],
): readonly NoticeRow[] {
  const scopes = [GLOBAL_SCOPE, ...owners.map((owner) => `${SESSION_SCOPE_PREFIX}${owner}`)];
  const seen = new Set<number>();
  const rows: NoticeRow[] = [];
  for (const scope of scopes) {
    const page = repo.list({ scope, includeAcked: false, limit: 200 });
    for (const row of page.notices) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/** Formats as many of `rows` (oldest — lowest `id` — first) as fit under
 * `NOTICE_OVERLAY_MAX_CHARS`; whatever doesn't fit is left out of
 * `included` entirely — the caller only ever acks `included`, so a notice
 * that misses this turn's cap stays pending for the next claim (AC2). A
 * `null` text for zero included rows keeps a no-notices turn byte-identical
 * (AC5). */
export function formatNoticeOverlay(rows: readonly NoticeRow[]): {
  readonly text: string | null;
  readonly included: readonly NoticeRow[];
} {
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const lines: string[] = [];
  const included: NoticeRow[] = [];
  for (const row of ordered) {
    const line = `- [${row.kind}] ${escapeMarkerKeyword(row.message)}`;
    const candidate = [OVERLAY_BEGIN, ...lines, line, OVERLAY_END].join("\n");
    if (candidate.length > NOTICE_OVERLAY_MAX_CHARS) break;
    lines.push(line);
    included.push(row);
  }
  if (included.length === 0) return { text: null, included: [] };
  return { text: [OVERLAY_BEGIN, ...lines, OVERLAY_END].join("\n"), included };
}

// Exact `ConversationError.code` → `NoticeKind` map (src/conversation/
// errors.ts). Deliberately NOT exhaustive: the vocabulary is frozen without
// an ADR (épico #575 decision), so any code this table doesn't name maps to
// "unknown" below rather than inventing a new kind.
const CODE_TO_KIND: ReadonlyArray<readonly [code: string, kind: NoticeKind]> = [
  ["CONTEXT_WINDOW_EXCEEDED", "context_length"],
  ["CONVERSATION_CANCELLED", "cancelled"],
];

// Issue #608: `cause` here is the top-level `ConversationError` `runtime.ts`'s
// `catch` passes to `publishFailure` — the PROVIDER error a route/quota fault
// actually lives on sits one level down, at `cause.cause`
// (`ConversationTurnFailedError`'s own constructor puts it there). A cause
// with no `.cause` of its own (`MaxIterationsError`, a bare `Error`) is
// classified as itself — `classifyProviderError` returns `null` for
// anything that isn't a provider failure shape, which folds into `"unknown"`
// below exactly like before this issue.
function providerCauseOf(cause: unknown): unknown {
  return cause instanceof Error && cause.cause !== undefined ? cause.cause : cause;
}

/** Turn-death notice (AC4, #608 AC2): `code` maps to its `NoticeKind` by
 * exact match first (the frozen vocabulary above); failing that,
 * `classifyProviderError` (`src/transports/errors.ts`) reads the underlying
 * provider error a dead turn's `ConversationTurnFailedError` carries as its
 * own `.cause` — `route_fault`/`quota_exhausted`/etc instead of a blanket
 * `"unknown"` for a turn that died on a classifiable provider failure.
 * `"unknown"` only when NEITHER source names a kind. */
export function buildTurnNotice(
  code: string,
  cause: unknown,
): { readonly kind: NoticeKind; readonly message: string } {
  const exact = CODE_TO_KIND.find(([marker]) => marker === code)?.[1];
  const kind = exact ?? classifyProviderError(providerCauseOf(cause)) ?? "unknown";
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { kind, message: `turn failed (${code}): ${detail}` };
}

export interface TurnNoticesPortOptions {
  readonly repository: NoticesOverlayRepository;
  readonly sessions: LineageSource;
  readonly actor?: string;
  readonly now?: () => number;
  readonly warning?: (message: string) => void;
}

const NO_CLAIM: TurnNoticesClaim = { token: [], overlay: null };

/** The real `TurnNoticesPort` production wires into `ConversationRuntimeOptions
 * .notices` (`chat.ts`/`dashboard.ts`). Every method fails open — a broken
 * notices store degrades to "no overlay this turn", never a faulted turn
 * that had nothing to do with it; `warning` is the non-silent trace CLAUDE.md
 * invariant 2 asks for. */
export function createTurnNoticesPort(options: TurnNoticesPortOptions): TurnNoticesPort {
  const actor = options.actor ?? "conversation-runtime";
  const warn = options.warning ?? ((): void => undefined);
  return {
    claim(sessionId: string): TurnNoticesClaim {
      try {
        const owners = options.sessions.lineageRootToTip(sessionId);
        const rows = claimLineageNotices(options.repository, owners);
        const { text, included } = formatNoticeOverlay(rows);
        return { token: included.map((row) => row.id), overlay: text };
      } catch (error) {
        warn(`notices overlay: claim failed for session ${sessionId} — ${String(error)}`);
        return NO_CLAIM;
      }
    },
    ack(token: readonly number[]): void {
      for (const id of token) {
        try {
          options.repository.ack(id, actor, options.now?.());
        } catch (error) {
          warn(`notices overlay: ack failed for notice ${String(id)} — ${String(error)}`);
        }
      }
    },
    publishFailure(sessionId: string, code: string, cause: unknown): void {
      try {
        const { kind, message } = buildTurnNotice(code, cause);
        options.repository.append(`${SESSION_SCOPE_PREFIX}${sessionId}`, { kind, message });
      } catch (error) {
        warn(`notices overlay: publishFailure failed for session ${sessionId} — ${String(error)}`);
      }
    },
  };
}

// Re-exported purely so a consumer importing this module's own return type
// never needs a second import from ../conversation/types.js just to name it.
export type { TurnNoticesClaim, TurnNoticesPort };
