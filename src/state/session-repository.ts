import type Database from "better-sqlite3";

import { LockRepository } from "./locks.js";
import { stringifyJsonPreservingNumbers } from "../serialization/json-numbers.js";
import { nullableInteger, safeInteger } from "./values.js";

export interface CompactionResult {
  readonly summarizedCount: number;
  readonly keptCount: number;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly source?: string;
  readonly model?: string | null;
  readonly systemPrompt?: string | null;
  readonly parentSessionId?: string | null;
  readonly cwd?: string | null;
  readonly title?: string | null;
  readonly startedAt?: number;
}

export interface MessageInput {
  readonly role: string;
  readonly content?: string | null;
  readonly toolCallId?: string | null;
  readonly toolCalls?: unknown;
  readonly name?: string | null;
  readonly createdAt?: number;
  readonly finishReason?: string | null;
  readonly reasoning?: string | null;
  readonly providerData?: unknown;
}

export interface UsageIncrement {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly apiCalls?: number;
  readonly realUsd?: number | null;
  readonly grossUsd?: number | null;
}

export interface RecordTurnInput {
  readonly user: MessageInput;
  readonly assistant: MessageInput;
  readonly usage?: UsageIncrement | null;
}

export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly apiCallCount: number;
  readonly pricedCallCount: number | null;
  readonly actualCostUsd: number | null;
  readonly estimatedCostUsd: number | null;
}

type SqliteInteger = bigint | number;
type Row = Readonly<Record<string, unknown>>;

function meaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function jsonText(value: unknown): string | null {
  return meaningful(value) ? stringifyJsonPreservingNumbers(value) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function reconstructMessage(row: Row): Readonly<Record<string, unknown>> {
  const role = String(row.role);
  if (role === "user") return { role, content: text(row.content) };
  if (role === "tool") {
    return {
      role,
      name: text(row.tool_name),
      tool_call_id: text(row.tool_call_id),
      content: text(row.content),
    };
  }
  if (role === "assistant") {
    const hasToolCalls = text(row.tool_calls) !== null;
    const result: Record<string, unknown> = {
      role,
      content: hasToolCalls && text(row.content) === "" ? null : (text(row.content) ?? ""),
      finish_reason: text(row.finish_reason),
    };
    if (text(row.reasoning)) result.reasoning = text(row.reasoning);
    if (text(row.tool_calls)) result.tool_calls = JSON.parse(text(row.tool_calls) as string);
    if (text(row.reasoning_details))
      result.provider_data = JSON.parse(text(row.reasoning_details) as string);
    return result;
  }
  if (role === "system") return { role, content: text(row.content) };
  throw new Error(`SESSION_MESSAGE_ROLE_INVALID:${role}`);
}

export class SessionRepository {
  // Owns its own LockRepository over the SAME connection (issue #252): both
  // read/write the same `database` handle passed in below, so every caller
  // that already constructs a SessionRepository (chat.ts, the gateway) gets
  // compaction locking for free, with zero changes at those call sites.
  private readonly locks: LockRepository;

  public constructor(
    private readonly database: Database.Database,
    private readonly now: () => number = () => Date.now() / 1000,
    private readonly ftsEnabled = true,
  ) {
    this.locks = new LockRepository(database);
  }

  public createSession(input: CreateSessionInput): void {
    this.database
      .prepare(
        `INSERT INTO sessions
         (id, source, model, system_prompt, parent_session_id, started_at, cwd, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.source ?? "cli",
        input.model ?? null,
        input.systemPrompt ?? null,
        input.parentSessionId ?? null,
        input.startedAt ?? this.now(),
        input.cwd ?? null,
        input.title ?? null,
      );
  }

  public endSession(id: string, reason: string, endedAt = this.now()): void {
    this.database
      .prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?")
      .run(endedAt, reason, id);
  }

  public getSession(id: string): Row | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      Row | undefined;
    return row ?? null;
  }

  public listSessions(
    options: { readonly limit?: number; readonly includeArchived?: boolean } = {},
  ): readonly Row[] {
    const clauses = ["source != 'orchestration'"];
    if (!(options.includeArchived ?? false)) clauses.push("archived = 0");
    return this.database
      .prepare(
        `SELECT id, title, model, parent_session_id, started_at, ended_at,
                end_reason, message_count FROM sessions
         WHERE ${clauses.join(" AND ")}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(Math.max(0, options.limit ?? 50)) as Row[];
  }

  private insertMessage(sessionId: string, message: MessageInput): number {
    const result = this.database
      .prepare(
        `INSERT INTO messages
           (session_id, role, content, tool_call_id, tool_calls, tool_name,
            timestamp, finish_reason, reasoning, reasoning_details, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        sessionId,
        message.role,
        message.content ?? null,
        message.toolCallId ?? null,
        jsonText(message.toolCalls),
        message.name ?? null,
        message.createdAt ?? this.now(),
        message.finishReason ?? null,
        message.reasoning ?? null,
        jsonText(message.providerData),
      );
    return safeInteger(result.lastInsertRowid, "messages.id");
  }

  // Raw copy of a previously-stored row into a fresh row (issue #252,
  // compaction's "reinsert the kept tail" step) -- unlike insertMessage,
  // takes already-serialized column values verbatim instead of running them
  // back through jsonText()/meaningful(), so a value that survived one
  // round-trip through the DB can never come out reformatted or truncated
  // by a second one.
  private insertMessageRow(sessionId: string, row: Row): number {
    const result = this.database
      .prepare(
        `INSERT INTO messages
           (session_id, role, content, tool_call_id, tool_calls, tool_name,
            timestamp, finish_reason, reasoning, reasoning_details, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        sessionId,
        row.role,
        row.content,
        row.tool_call_id,
        row.tool_calls,
        row.tool_name,
        row.timestamp,
        row.finish_reason,
        row.reasoning,
        row.reasoning_details,
      );
    return safeInteger(result.lastInsertRowid, "messages.id");
  }

  public acquireCompressionLock(
    sessionId: string,
    holder: string,
    now: number,
    ttlSeconds: number,
  ): boolean {
    return this.locks.acquireCompressionLock(sessionId, holder, now, ttlSeconds);
  }

  public releaseCompressionLock(sessionId: string, holder: string): boolean {
    return this.locks.releaseCompressionLock(sessionId, holder);
  }

  /**
   * Atomically rewrites `sessionId`'s active history (issue #252): every
   * currently-active row is deactivated, `input.summary` is inserted as a
   * fresh assistant message, and the trailing `input.keepTailCount` rows
   * (the ones the caller decided must survive untouched) are reinserted
   * verbatim right after it. Reinserting the kept tail — instead of leaving
   * its original rows alone — is deliberate: `loadMessages` orders by `id`,
   * and the summary's own row always gets a HIGHER id than rows already in
   * the table, so leaving the kept tail's original (lower) ids in place
   * would put the summary AFTER the tail it's supposed to precede.
   * Refuses to write (throws) unless `holder` currently holds the
   * compression lock for `sessionId` — invariant 4, checked inside the same
   * transaction as the write, never as a separate racy step. Returns
   * `{ summarizedCount: 0, keptCount }` without writing anything when there
   * is nothing left to fold (the caller's futile-compaction signal).
   */
  public compactHistory(
    sessionId: string,
    holder: string,
    now: number,
    input: { readonly keepTailCount: number; readonly summary: string },
  ): CompactionResult {
    const transaction = this.database.transaction(() => {
      const heldLock = this.database
        .prepare(
          "SELECT 1 FROM compression_locks WHERE session_id = ? AND holder = ? AND expires_at > ?",
        )
        .get(sessionId, holder, now);
      if (heldLock === undefined) {
        throw new Error(`COMPRESSION_LOCK_NOT_HELD:${sessionId}`);
      }
      const rows = this.database
        .prepare("SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY id")
        .all(sessionId) as Row[];
      const keepCount = Math.min(Math.max(0, Math.trunc(input.keepTailCount)), rows.length);
      const summarizedCount = rows.length - keepCount;
      if (summarizedCount <= 0) return { summarizedCount: 0, keptCount: rows.length };

      const toKeep = rows.slice(summarizedCount);
      const placeholders = rows.map(() => "?").join(",");
      this.database
        .prepare(`UPDATE messages SET active = 0 WHERE id IN (${placeholders})`)
        .run(...rows.map((row) => row.id as SqliteInteger));

      // Shape matches src/conversation/compaction.ts's buildSummaryMessage:
      // role "assistant" (never "system" -- see that module's comment on
      // why), finish_reason "stop" like any other completed reply.
      this.insertMessage(sessionId, {
        role: "assistant",
        content: input.summary,
        createdAt: now,
        finishReason: "stop",
      });
      let inserted = 1;
      for (const row of toKeep) {
        this.insertMessageRow(sessionId, row);
        inserted += 1;
      }
      this.database
        .prepare("UPDATE sessions SET message_count = message_count + ? WHERE id = ?")
        .run(inserted, sessionId);
      return { summarizedCount, keptCount: toKeep.length };
    });
    return transaction();
  }

  public appendMessage(sessionId: string, message: MessageInput): number {
    const transaction = this.database.transaction(() => {
      const id = this.insertMessage(sessionId, message);
      this.database
        .prepare("UPDATE sessions SET message_count = message_count + 1 WHERE id = ?")
        .run(sessionId);
      return id;
    });
    return transaction();
  }

  public recordTurn(sessionId: string, input: RecordTurnInput): void {
    const transaction = this.database.transaction(() => {
      this.insertMessage(sessionId, input.user);
      this.insertMessage(sessionId, input.assistant);
      this.database
        .prepare("UPDATE sessions SET message_count = message_count + 2 WHERE id = ?")
        .run(sessionId);
      if (input.usage !== undefined && input.usage !== null) this.addUsage(sessionId, input.usage);
    });
    transaction();
  }

  public recordMessages(
    sessionId: string,
    messages: readonly MessageInput[],
    usage?: UsageIncrement | null,
  ): void {
    const transaction = this.database.transaction(() => {
      for (const message of messages) this.insertMessage(sessionId, message);
      this.database
        .prepare("UPDATE sessions SET message_count = message_count + ? WHERE id = ?")
        .run(messages.length, sessionId);
      if (usage !== undefined && usage !== null) this.addUsage(sessionId, usage);
    });
    transaction();
  }

  public loadMessages(
    sessionId: string,
    activeOnly = true,
  ): readonly Readonly<Record<string, unknown>>[] {
    const active = activeOnly ? " AND active = 1" : "";
    const rows = this.database
      .prepare(`SELECT * FROM messages WHERE session_id = ?${active} ORDER BY id`)
      .all(sessionId) as Row[];
    return rows.map(reconstructMessage);
  }

  public addUsage(sessionId: string, usage: UsageIncrement): void {
    const apiCalls = Math.max(1, Math.trunc(usage.apiCalls || 1));
    this.database
      .prepare(
        `UPDATE sessions SET
           input_tokens = COALESCE(input_tokens, 0) + ?,
           output_tokens = COALESCE(output_tokens, 0) + ?,
           cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
           cache_write_tokens = COALESCE(cache_write_tokens, 0) + ?,
           reasoning_tokens = COALESCE(reasoning_tokens, 0) + ?,
           api_call_count = COALESCE(api_call_count, 0) + ?,
           priced_call_count = COALESCE(priced_call_count, 0) +
             CASE WHEN ? IS NULL THEN 0 ELSE ? END,
           actual_cost_usd = CASE WHEN ? IS NULL THEN actual_cost_usd
             ELSE COALESCE(actual_cost_usd, 0) + ? END,
           estimated_cost_usd = CASE WHEN ? IS NULL THEN estimated_cost_usd
             ELSE COALESCE(estimated_cost_usd, 0) + ? END
         WHERE id = ?`,
      )
      .run(
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        usage.reasoningTokens ?? 0,
        apiCalls,
        usage.realUsd ?? null,
        apiCalls,
        usage.realUsd ?? null,
        usage.realUsd ?? null,
        usage.grossUsd ?? null,
        usage.grossUsd ?? null,
        sessionId,
      );
  }

  public usage(sessionId: string): SessionUsage | null {
    const row = this.database
      .prepare(
        `SELECT input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, reasoning_tokens, api_call_count,
                priced_call_count, actual_cost_usd, estimated_cost_usd
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as Row | undefined;
    if (row === undefined) return null;
    return {
      inputTokens: safeInteger(row.input_tokens as SqliteInteger, "input_tokens"),
      outputTokens: safeInteger(row.output_tokens as SqliteInteger, "output_tokens"),
      cacheReadTokens: safeInteger(
        (row.cache_read_tokens ?? 0n) as SqliteInteger,
        "cache_read_tokens",
      ),
      cacheWriteTokens: safeInteger(
        (row.cache_write_tokens ?? 0n) as SqliteInteger,
        "cache_write_tokens",
      ),
      reasoningTokens: safeInteger(
        (row.reasoning_tokens ?? 0n) as SqliteInteger,
        "reasoning_tokens",
      ),
      apiCallCount: safeInteger(row.api_call_count as SqliteInteger, "api_call_count"),
      pricedCallCount: nullableInteger(
        row.priced_call_count as SqliteInteger | null,
        "priced_call_count",
      ),
      actualCostUsd: number(row.actual_cost_usd),
      estimatedCostUsd: number(row.estimated_cost_usd),
    };
  }

  public lineageRootToTip(sessionId: string): readonly string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | null = sessionId;
    for (let count = 0; count < 100 && current !== null && !seen.has(current); count += 1) {
      const row = this.getSession(current);
      if (row === null) break;
      chain.push(current);
      seen.add(current);
      current = text(row.parent_session_id);
    }
    return chain.reverse();
  }

  public searchMessages(query: string, limit = 10): readonly Row[] {
    if (!this.ftsEnabled || query.trim().length === 0) return [];
    try {
      const rows = this.database
        .prepare(
          `SELECT messages_fts.session_id AS session_id,
                  messages_fts.message_id AS message_id,
                  m.role AS role,
                  snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
           FROM messages_fts JOIN messages m ON m.id = messages_fts.message_id
           WHERE messages_fts MATCH ?
           ORDER BY bm25(messages_fts)
           LIMIT ?`,
        )
        .all(query, limit) as Row[];
      return rows.map((row) => ({
        ...row,
        message_id: safeInteger(row.message_id as SqliteInteger, "messages_fts.message_id"),
      }));
    } catch (error) {
      if (
        error instanceof Error &&
        /fts5: syntax error|unterminated string|malformed MATCH/i.test(error.message)
      ) {
        return [];
      }
      throw error;
    }
  }
}
