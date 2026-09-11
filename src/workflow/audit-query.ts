import type { ToolArguments } from "../tools/types.js";
import type { AuditQuery } from "../state/audit-repository.js";

export type AuditQueryResult = { readonly query: AuditQuery } | { readonly error: string };

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^[+-]?\d+$/.test(value)
      ? Number.parseInt(value, 10)
      : undefined;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function parseAuditQuery(args: ToolArguments): AuditQueryResult {
  if (typeof args.run_id !== "string" || args.run_id === "")
    return Object.freeze({ error: "workflow_audit requires 'run_id'" });
  const after = args.after_seq === undefined ? 0 : integer(args.after_seq);
  const snapshotRaw = args.snapshot_seq === undefined ? undefined : integer(args.snapshot_seq);
  const attemptRaw = args.attempt === undefined ? undefined : integer(args.attempt);
  const limit = args.limit === undefined ? 50 : integer(args.limit);
  if (after === undefined || after < 0 || (snapshotRaw !== undefined && snapshotRaw < 0))
    return Object.freeze({ error: "audit cursors must be >= 0" });
  if (limit === undefined || limit < 1 || (attemptRaw !== undefined && attemptRaw < 0))
    return Object.freeze({ error: "audit limit must be >= 1 and attempt >= 0" });
  for (const key of ["node_id", "event_type", "sub_id", "segment_id"] as const)
    if (args[key] !== undefined && typeof args[key] !== "string")
      return Object.freeze({ error: `audit ${key} must be a string` });
  // Um attempt real (o que o ledger grava) começa em 1 — 0 nunca bate contra
  // nenhum evento. Um chamador com schema estrito (Codex `strict: true`)
  // preenche todo o schema em vez de omitir campos opcionais, então 0 chega
  // como "não tenho filtro", não como "filtre por attempt zero" (#390).
  // Tratamos como ausência em vez de rejeitar: rejeitar quebraria esse
  // chamador para uma query que devia simplesmente ignorar o filtro.
  const attempt = attemptRaw === 0 ? undefined : attemptRaw;
  // snapshot_seq é o high-water mark que a página um devolveu — nunca 0 para
  // um run com eventos (o primeiro seq gravado é 1). Sem essa correção,
  // `snapshot_seq: 0` do mesmo chamador estrito passava direto para
  // `AuditRepository.query`, que trava o scan em `Math.max(0, snapshotSeq ??
  // currentHigh)` (audit-repository.ts:344) — 0 explícito nunca cai no
  // fallback `?? currentHigh`, então a leitura via um leitor estrito
  // devolvia `events: []` mesmo sem nenhum filtro de conteúdo ativo (#390,
  // dogfooding real). Um run de fato sem eventos ainda devolve `events: []`
  // tratando 0 como ausente — não há regressão observável para esse caso.
  const snapshot = snapshotRaw === 0 ? undefined : snapshotRaw;
  return Object.freeze({
    query: Object.freeze({
      runId: args.run_id,
      afterSeq: after,
      limit,
      ...(snapshot === undefined ? {} : { snapshotSeq: snapshot }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(hasText(args.node_id) ? { nodeId: args.node_id } : {}),
      ...(hasText(args.event_type) ? { eventType: args.event_type } : {}),
      ...(hasText(args.sub_id) ? { subId: args.sub_id } : {}),
      ...(hasText(args.segment_id) ? { segmentId: args.segment_id } : {}),
    }),
  });
}
