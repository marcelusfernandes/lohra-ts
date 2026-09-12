// Issue #498 (follow-up de #477, PR #493 → veredito non_blocking 1):
// `AuditRepository.query()` decodificava `snapshotRows` (todas as linhas do
// run até `snapshot`, via `parseEvent`) em toda chamada só para derivar
// `notices`/`event_markers`/`field_markers`, run-wide por contrato — uma
// página custava proporcional ao run inteiro, não à própria página (21
// páginas de um run com N eventos = 21 × N `parseEvent`).
//
// `tests/state-audit-repository.test.ts` prende o custo por chamada (um
// `vi.spyOn(JSON, "parse")` conta as decodificações; a base decodifica as
// 300 linhas do run, a correção decodifica só `limit+1` + marcadores) e
// re-prova, no mesmo arquivo, que a página/paginação/filtros em SQL (#477)
// continuam byte-idênticos. `tests/workflow-audit-live.test.ts` (fora deste
// slug — 1211 linhas, fora dos `Files` da issue) já cobre os oráculos de
// `field_markers`/`event_markers`/`notices`, incluindo o caso de linha
// adulterada diretamente no SQLite, e continua verde sem alteração.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/state-audit-repository.test.ts"],
  check: true,
} satisfies Declaracao;
