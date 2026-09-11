// Issue #400 (M8-4): irmão de `AuditRepository` (`audit-repository.ts`), mas
// para avisos ao operador (`operator_notices`) em vez de trilha de auditoria.
// Stub vermelho: só a forma pública (tipos + assinaturas) existe; todo
// método real lança até o commit verde — controle-negativo (`worktree-segura`
// §7) exige que o vermelho seja de runtime, não de import quebrado.
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

export const NOTICES_SCOPE_CAP = 256;

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

export class NoticesRepository {
  public constructor(
    private readonly database: Database.Database,
    _options: NoticesRepositoryOptions = {},
  ) {}

  public append(_scope: string, _input: NoticeInput, _ownership?: Ownership): PublicNotice | null {
    throw new Error("not implemented: NoticesRepository.append");
  }

  public list(_query: NoticesListQuery = {}): NoticesPage {
    throw new Error("not implemented: NoticesRepository.list");
  }

  public ack(_id: number, _actor: string, _now?: number): boolean {
    throw new Error("not implemented: NoticesRepository.ack");
  }
}
