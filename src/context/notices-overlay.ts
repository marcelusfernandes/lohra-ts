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

export const NOTICE_OVERLAY_MAX_CHARS = 4096;
const OVERLAY_BEGIN = "OPERATOR NOTICES (not the user speaking):";
const OVERLAY_END = "END OPERATOR NOTICES";
const GLOBAL_SCOPE = "global";
const SESSION_SCOPE_PREFIX = "session:";

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
    const line = `- [${row.kind}] ${row.message}`;
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

/** Turn-death notice (AC4): a `NoticeKind` this runtime is already allowed
 * to write, mapped from `code` by exact match, `"unknown"` otherwise. */
export function buildTurnNotice(
  code: string,
  cause: unknown,
): { readonly kind: NoticeKind; readonly message: string } {
  const kind = CODE_TO_KIND.find(([marker]) => marker === code)?.[1] ?? "unknown";
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
