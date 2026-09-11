// Issue #380: apontado pelo revisor da PR #379 (#368) — `AuditRepository` e
// `AuditTrail` aceitam um sink de aviso (`warning`), mas os construtores em
// produção (`session-tools.ts:createSessionToolBase`, `chat-tools.ts
// :createChatToolRegistry`, e o `new AuditTrail(...)` de `chat.ts`/
// `dashboard.ts`) usavam o default `() => undefined` — uma recusa por fence
// nomeada (`audit-repository.ts`) nunca chegava a lugar nenhum fora de um
// teste com sink injetado. `createSessionToolBase`/`createChatToolRegistry`
// agora default para um sink real (console.warn), e chat.ts/dashboard.ts
// passam o mesmo sink explicitamente ao `AuditTrail` que constroem. Achado
// no caminho: `AuditRepository.append` já logava a MESMA recusa duas vezes
// internamente (dentro da transação e de novo logo depois dela), e
// `AuditTrail.drain()` logava uma terceira — três linhas por recusa, não
// duas como o relato original media. Consolidado num único ponto
// (`audit-repository.ts`, pós-transação) que também conta e limita
// `refusals` (LRU por `maxRuns`, já que um run só de recusas nunca ganha
// uma linha em `workflow_audit_state` — `pruneRuns()`/`compact()` nunca o
// veem).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-identity.test.ts"],
} satisfies Declaracao;
