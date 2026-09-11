// Issue #400 (M8-4): irmão de `AuditRepository` (`audit-repository.ts`), mas
// para avisos ao operador (`operator_notices`) em vez de trilha de
// auditoria. Mesmo molde: predicado de dono no `append` copiado de
// `audit-repository.ts:196-200` (JOIN `workflow_run_fence`/
// `workflow_run_locks`), recusa nomeada por um único `warning` pós-transação
// (nunca dois logs pela mesma recusa, decisão #380), contador de recusas
// LRU por escopo, `next_seq` por escopo em tabela irmã, retenção limitada.
import type Database from "better-sqlite3";

import type { Ownership } from "./workflow-repository.js";

// Vocabulário local: os 9 kinds da issue #397 (`ERROR_KINDS`, ainda não
// mergeada) mais os 4 kinds específicos de estado/durabilidade que esta
// issue introduz. Unificar com `src/transports/error-kinds.ts` quando #397
// mergear (M8-5).
export const NOTICE_KINDS = [
  "quota_exhausted",
  "auth_failed",
  "model_not_found",
  "route_fault",
  "sandbox_denied",
  "timeout",
  "cancelled",
  "context_length",
  "unknown",
  "stale_fence_write",
  "audit_sink_failure",
  "resume_attempts_exhausted",
  "queue_overflow",
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const NOTICE_KIND_SET: ReadonlySet<string> = new Set(NOTICE_KINDS);

/** Teto de avisos retidos por escopo (LRU: reconhecidos caem primeiro). */
export const NOTICES_SCOPE_CAP = 256;

/** Bytes máximos de `message`, truncada com marcador quando excedida. */
const MAX_MESSAGE_BYTES = 2048;
const TRUNCATION_MARKER = "…[truncated]";

const GLOBAL_SCOPE = "global";

export interface NoticeInput {
  readonly kind: string;
  readonly message: string;
}

export interface PublicNotice extends Readonly<Record<string, unknown>> {
  readonly id: number;
  readonly scope: string;
  readonly seq: number;
  readonly kind: NoticeKind;
  readonly message: string;
  readonly created_at: number;
  readonly acked_at: number | null;
  readonly acked_by: string | null;
  readonly fence: number | null;
}

export interface NoticesListQuery {
  readonly scope?: string;
  readonly afterSeq?: number;
  readonly includeAcked?: boolean;
  readonly limit?: number;
}

export interface NoticesPage extends Readonly<Record<string, unknown>> {
  readonly notices: readonly PublicNotice[];
  readonly next_after_seq: number;
  readonly has_more: boolean;
  readonly refused_writes: number;
  readonly dropped_before_seq?: number;
}

export interface NoticesRepositoryOptions {
  readonly maxPerScope?: number;
  readonly maxScopes?: number;
  readonly warning?: (message: string) => void;
}

interface ParsedScope {
  readonly runId: string | null;
}

/** `"global"` ou `"run:<id>"` com id não vazio; qualquer outra forma é inválida. */
function parseScope(scope: string): ParsedScope | null {
  if (scope === GLOBAL_SCOPE) return { runId: null };
  if (scope.startsWith("run:") && scope.length > "run:".length) {
    return { runId: scope.slice("run:".length) };
  }
  return null;
}

function rowNumber(value: unknown): number {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function nullableRowNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : rowNumber(value);
}

/**
 * Trunca `message` para caber em `MAX_MESSAGE_BYTES` bytes UTF-8, contando o
 * marcador. Corta por BYTE (não por char): uma mensagem com caracteres
 * multi-byte (acentos, emoji) cortada no meio de uma sequência produziria
 * U+FFFD — o laço recua enquanto o próximo byte é um byte de continuação
 * (`10xxxxxx`, ou seja, `byte & 0xc0 === 0x80`).
 */
function truncateMessage(message: string): string {
  const buffer = Buffer.from(message, "utf8");
  if (buffer.byteLength <= MAX_MESSAGE_BYTES) return message;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, MAX_MESSAGE_BYTES - markerBytes);
  let end = Math.min(budget, buffer.byteLength);
  while (end > 0) {
    const nextByte = buffer.at(end);
    if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8") + TRUNCATION_MARKER;
}

function parseNoticeRow(row: Readonly<Record<string, unknown>>): PublicNotice {
  return Object.freeze({
    id: rowNumber(row.id),
    scope: String(row.scope),
    seq: rowNumber(row.seq),
    kind: String(row.kind) as NoticeKind,
    message: String(row.message),
    created_at: Number(row.created_at),
    acked_at: nullableRowNumber(row.acked_at),
    acked_by: typeof row.acked_by === "string" ? row.acked_by : null,
    fence: nullableRowNumber(row.fence),
  });
}

export class NoticesRepository {
  private readonly maxPerScope: number;
  private readonly maxScopes: number;
  private readonly warning: (message: string) => void;
  // Mesmo desenho de `AuditRepository.refusals` (`audit-repository.ts:172`):
  // em memória só, LRU por `maxScopes` — reinserir na recusa move o escopo
  // para o fim, então a evicção nunca remove a chave recém-tocada.
  private readonly refusals = new Map<string, number>();

  public constructor(
    private readonly database: Database.Database,
    options: NoticesRepositoryOptions = {},
  ) {
    this.maxPerScope = Math.max(1, Math.trunc(options.maxPerScope ?? NOTICES_SCOPE_CAP));
    this.maxScopes = Math.max(1, Math.trunc(options.maxScopes ?? NOTICES_SCOPE_CAP));
    this.warning = options.warning ?? (() => undefined);
  }

  public append(scope: string, input: NoticeInput, ownership?: Ownership): PublicNotice | null {
    const parsed = parseScope(scope);
    if (parsed === null) {
      this.warning(`notices: refused — invalid scope "${scope}" (expected "global" or "run:<id>")`);
      return null;
    }
    if (!NOTICE_KIND_SET.has(input.kind)) {
      this.warning(`notices: refused — invalid kind "${input.kind}" for scope ${scope}`);
      return null;
    }
    if (parsed.runId !== null && ownership === undefined) {
      this.warning(`notices: refused — scope ${scope} requires ownership (fence/holder)`);
      return null;
    }
    const now = ownership?.now ?? Date.now() / 1_000;
    const message = truncateMessage(input.message);
    const transact = this.database
      .transaction((): PublicNotice | null => {
        if (parsed.runId !== null && ownership !== undefined) {
          const owned = this.database
            .prepare(
              `SELECT 1 AS ok FROM workflow_run_fence f
           JOIN workflow_run_locks l ON l.run_id = f.run_id
           WHERE f.run_id = ? AND f.fence = ? AND l.holder = ? AND l.expires_at > ?`,
            )
            .get(parsed.runId, ownership.fence, ownership.holder, ownership.now);
          if (owned === undefined) return null;
        }
        const prior = this.database
          .prepare("SELECT next_seq FROM operator_notices_state WHERE scope = ?")
          .get(scope) as { readonly next_seq: bigint } | undefined;
        const seq = prior === undefined ? 1 : rowNumber(prior.next_seq);
        if (prior === undefined) {
          this.database
            .prepare(
              `INSERT INTO operator_notices_state (scope, next_seq, updated_at) VALUES (?, ?, ?)`,
            )
            .run(scope, seq + 1, now);
        } else {
          this.database
            .prepare(
              `UPDATE operator_notices_state SET next_seq = ?, updated_at = ? WHERE scope = ?`,
            )
            .run(seq + 1, now, scope);
        }
        const fenceValue = ownership?.fence ?? null;
        const info = this.database
          .prepare(
            `INSERT INTO operator_notices (scope, seq, kind, message, created_at, fence)
         VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(scope, seq, input.kind, message, now, fenceValue);
        this.pruneScope(scope);
        return this.readNotice(Number(info.lastInsertRowid));
      })
      .immediate();
    if (transact === null && parsed.runId !== null && ownership !== undefined) {
      // Toque de LRU: cair e reinserir move este escopo para o fim do Map,
      // então a evicção logo abaixo nunca remove a chave que acabou de ser
      // recusada.
      const priorRefusals = this.refusals.get(scope) ?? 0;
      this.refusals.delete(scope);
      this.refusals.set(scope, priorRefusals + 1);
      if (this.refusals.size > this.maxScopes) {
        const oldest = this.refusals.keys().next().value;
        if (oldest !== undefined) this.refusals.delete(oldest);
      }
      this.warning(`notices: append refused for scope ${scope} — fence lost (kind ${input.kind})`);
    }
    return transact;
  }

  public list(query: NoticesListQuery = {}): NoticesPage {
    const scope = query.scope;
    const includeAcked = query.includeAcked ?? false;
    const after = Math.max(0, Math.trunc(query.afterSeq ?? 0));
    const requestedLimit = Math.trunc(query.limit ?? 50);
    const limit = Math.min(200, Math.max(1, requestedLimit));
    const rows = this.database
      .transaction(() => {
        if (scope !== undefined) {
          return this.database
            .prepare(
              `SELECT * FROM operator_notices
             WHERE scope = ? AND seq > ? AND (? = 1 OR acked_at IS NULL)
             ORDER BY seq ASC LIMIT ?`,
            )
            .all(scope, after, includeAcked ? 1 : 0, limit + 1) as readonly Readonly<
            Record<string, unknown>
          >[];
        }
        return this.database
          .prepare(
            `SELECT * FROM operator_notices
           WHERE (? = 1 OR acked_at IS NULL)
           ORDER BY id ASC LIMIT ?`,
          )
          .all(includeAcked ? 1 : 0, limit + 1) as readonly Readonly<Record<string, unknown>>[];
      })
      .deferred();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(parseNoticeRow);
    const lastSeq = page.at(-1)?.seq ?? after;
    const droppedBeforeSeq = scope === undefined ? null : this.droppedBeforeSeqOf(scope);
    return Object.freeze({
      notices: Object.freeze(page),
      next_after_seq: scope === undefined ? 0 : lastSeq,
      has_more: hasMore,
      refused_writes: scope === undefined ? this.totalRefusals() : (this.refusals.get(scope) ?? 0),
      ...(droppedBeforeSeq === null ? {} : { dropped_before_seq: droppedBeforeSeq }),
    });
  }

  public ack(id: number, actor: string, now: number = Date.now() / 1_000): boolean {
    const result = this.database
      .prepare(
        `UPDATE operator_notices SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL`,
      )
      .run(now, actor, id);
    return result.changes > 0;
  }

  private readNotice(id: number): PublicNotice {
    const row = this.database
      .prepare("SELECT * FROM operator_notices WHERE id = ?")
      .get(id) as Readonly<Record<string, unknown>>;
    return parseNoticeRow(row);
  }

  private droppedBeforeSeqOf(scope: string): number | null {
    const row = this.database
      .prepare("SELECT dropped_before_seq FROM operator_notices_state WHERE scope = ?")
      .get(scope) as { readonly dropped_before_seq: bigint | null } | undefined;
    return row === undefined ? null : nullableRowNumber(row.dropped_before_seq);
  }

  private totalRefusals(): number {
    let total = 0;
    for (const count of this.refusals.values()) total += count;
    return total;
  }

  /**
   * Retenção LRU por escopo: acima do teto, os avisos RECONHECIDOS caem
   * primeiro (mais antigos primeiro entre eles); um aviso não-reconhecido só
   * cai quando não sobra nenhum reconhecido para cair no lugar dele — o
   * `ORDER BY (acked_at IS NULL) ASC, seq ASC` faz exatamente isso: acked
   * (0) ordena antes de not-acked (1), com `seq` como desempate.
   */
  private pruneScope(scope: string): void {
    const row = this.database
      .prepare("SELECT count(*) AS count FROM operator_notices WHERE scope = ?")
      .get(scope) as { readonly count: bigint };
    const overflow = Number(row.count) - this.maxPerScope;
    if (overflow <= 0) return;
    const victims = this.database
      .prepare(
        `SELECT id, seq FROM operator_notices WHERE scope = ?
       ORDER BY (acked_at IS NULL) ASC, seq ASC LIMIT ?`,
      )
      .all(scope, overflow) as readonly { readonly id: bigint; readonly seq: bigint }[];
    if (victims.length === 0) return;
    const placeholders = victims.map(() => "?").join(",");
    this.database
      .prepare(`DELETE FROM operator_notices WHERE id IN (${placeholders})`)
      .run(...victims.map((victim) => victim.id));
    const maxSeq = victims.reduce((high, victim) => Math.max(high, rowNumber(victim.seq)), 0);
    this.database
      .prepare(
        `UPDATE operator_notices_state
       SET retention_dropped = retention_dropped + ?,
           dropped_before_seq = MAX(COALESCE(dropped_before_seq, 0), ?)
       WHERE scope = ?`,
      )
      .run(victims.length, maxSeq, scope);
  }
}
