export interface ChatDelta {
  sessionId: string;
  delta: string;
}

/** Preflight compaction ran during a turn (issue #252, epic #230): the
 * history was rewritten under `compression_locks` before the model call
 * that would otherwise have overflowed the context window. Mirrors
 * `ConversationRuntimeEvent`'s `session.compacted` type + `compaction`
 * payload (`src/conversation/types.ts`) -- this is the wire shape a future
 * gateway/TUI/GUI subscriber renders it as, not yet wired to a live emitter. */
export interface SessionCompacted {
  sessionId: string;
  summarizedCount: number;
  keptCount: number;
  estimateBefore: number;
  estimateAfter: number;
}

export type ChatEvents = {
  delta: ChatDelta;
  compacted: SessionCompacted;
};
