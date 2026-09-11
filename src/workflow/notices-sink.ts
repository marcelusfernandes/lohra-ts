// Issue #401 (M8-5): unifies the eight ad hoc `console.warn` sinks this
// runtime carried (`docs`/epic #396 mapa §2) into ONE adapter per process.
// `warn`/`warnState` both keep printing to stderr — the dashboard/gateway's
// byte-fixed assertion (`src/gateway/failure-log.ts:4-10`) forbids adding a
// NEW console line, so every existing call site's own fallback is reused
// as-is — AND additionally record the same warning durably in
// `operator_notices` (`src/state/notices-repository.ts`, issue #400), so an
// operator can read it back from a DIFFERENT process after this one dies.
//
// `test(red)` stub (`worktree-segura` §7): the type surface is final —
// `tests/workflow-notices-sink.test.ts` imports `createNoticesSink` and
// `NoticesSinkRepository` directly — but the body just throws, so the red
// is a runtime failure, never a `tsc` error.
import type { NoticeInput, Ownership, PublicNotice, StateWarning } from "../state/index.js";

/** Structural, not the concrete class — a test can pass a stub repository
 * that throws on `append` without satisfying every `NoticesRepository`
 * member. */
export interface NoticesSinkRepository {
  append(scope: string, input: NoticeInput, ownership?: Ownership): PublicNotice | null;
}

export interface NoticesSinkStats {
  readonly dropped: number;
}

export interface NoticesSink {
  readonly warn: (message: string) => void;
  readonly warnState: (warning: StateWarning) => void;
  readonly stats: () => NoticesSinkStats;
}

export interface NoticesSinkOptions {
  readonly repository: NoticesSinkRepository;
  readonly ownership?: (runId: string) => Ownership | null;
  /** The `console.warn` (or equivalent) an existing call site already
   * uses — this sink never removes it, only adds a durable write beside
   * it. */
  readonly fallback: (message: string) => void;
}

export function createNoticesSink(options: NoticesSinkOptions): NoticesSink {
  void options;
  throw new Error("not implemented: createNoticesSink");
}
