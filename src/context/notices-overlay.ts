// Issue #589 (épico #575 P13): delivers pending `operator_notices`
// (src/state/notices-repository.ts) into the turn itself, so a model that
// never calls `workflow_notices` still sees what happened. Claim/format
// live here — never in `src/conversation/runtime.ts`, already at CLAUDE.md's
// 800-line cap — which only ever calls the `TurnNoticesPort` this factory
// returns (`src/conversation/types.ts`).
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

export function claimLineageNotices(
  _repo: NoticesOverlayRepository,
  _owners: readonly string[],
): readonly NoticeRow[] {
  throw new Error(
    `not implemented: claimLineageNotices (scopes: ${GLOBAL_SCOPE}, ${SESSION_SCOPE_PREFIX}<id>)`,
  );
}

export function formatNoticeOverlay(_rows: readonly NoticeRow[]): {
  readonly text: string | null;
  readonly included: readonly NoticeRow[];
} {
  throw new Error(`not implemented: formatNoticeOverlay (${OVERLAY_BEGIN} / ${OVERLAY_END})`);
}

export function buildTurnNotice(
  _code: string,
  _cause: unknown,
): { readonly kind: NoticeKind; readonly message: string } {
  throw new Error("not implemented: buildTurnNotice");
}

export interface TurnNoticesPortOptions {
  readonly repository: NoticesOverlayRepository;
  readonly sessions: LineageSource;
  readonly actor?: string;
  readonly now?: () => number;
  readonly warning?: (message: string) => void;
}

export function createTurnNoticesPort(_options: TurnNoticesPortOptions): TurnNoticesPort {
  throw new Error("not implemented: createTurnNoticesPort");
}

// Re-exported purely so a consumer importing this module's own return type
// never needs a second import from ../conversation/types.js just to name it.
export type { TurnNoticesClaim, TurnNoticesPort };
