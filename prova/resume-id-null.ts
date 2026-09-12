// Issue #513 (follow-up de #500, PR #506 veredito non_blocking 1 e 2):
// `normalizeResumeId` (`src/orchestration/validation.ts`) só tratava string
// vazia/só-espaços como ausência — `null` (`typeof null !== "string"`)
// escapava e ainda disparava o guard de resume (max_iterations) com uma
// mensagem enganosa, igual ao quirk original de #500. A normalização também
// devolvia `{...args, resume_id: undefined}`, deixando a chave presente:
// um futuro `"resume_id" in args` regrediria em silêncio. Agora
// `undefined`/`null`/string vazia contam como ausência e a chave é removida
// por completo (cópia sem `resume_id`, sem mutar `args`); outros
// não-strings (42) seguem intocados, recusados pelo guard existente
// (nome do sub_id no erro).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/orchestration-tools.test.ts"],
} satisfies Declaracao;
