// Tipos compartilhados do harness de mutação (issue #148, passo 0a do épico
// #13). Absorve o embrião do `mutants-types.ts` legado de paridade
// (`Edit`, `Focus`, `Mutant`) e acrescenta `MutationReport`, o formato comum
// que os seis runners legados de paridade hoje produzem de seis jeitos
// diferentes (t16 tem `byCategory`; t20/t21 não têm `killed`/`total`/
// `restoreGreen`). Nenhum runner é migrado nesta issue — só o tipo existe.
//
// Nenhum símbolo aqui depende de I/O; quem lê ou escreve disco é sempre
// `harness.ts`.

/** Uma substituição textual exata num arquivo do candidato. */
export interface Edit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

/** O teste focal que precisa ficar vermelho sob o mutante. */
export interface Focus {
  /** O arquivo de teste onde o oráculo deste mutante mora. */
  readonly file: string;
  /** Padrão `vitest -t` que nomeia o teste exato que precisa matar o mutante. */
  readonly test: string;
}

/** Um mutante: um ou mais edits, escorados por um único foco. */
export interface Mutant {
  readonly id: string;
  readonly category: string;
  readonly mechanism: string;
  readonly focus: Focus;
  readonly edits: readonly Edit[];
}

/** O resultado de um único mutante dentro de `MutationReport.mutants`
 * (issue #149, follow-up ao veredito da PR #173/#152): o mínimo que os
 * runners aposentados sempre gravavam (`mechanism`/`killedBy` completos)
 * e que a #148 tinha deixado de fora — sem isso, a evidência durável em
 * `.mutation-evidence/<fatia>/mutations.json` é mais pobre que a que
 * substitui. `category` e `killedBy` são opcionais porque nem todo
 * catálogo agrupa por categoria nem todo runner captura os nomes dos
 * testes que mataram o mutante. */
export interface MutantResult {
  readonly id: string;
  readonly category?: string;
  readonly killed: boolean;
  readonly killedBy?: readonly string[];
  readonly files: readonly string[];
}

/**
 * Forma comum do relatório de uma corrida de mutação. Cada suíte escreve
 * exatamente este shape — `byCategory` é opcional porque nem toda suíte
 * agrupa mutantes por categoria, e `mutants` é opcional para não quebrar
 * os runners que ainda não populam o detalhe por mutante (#150/#151/#152).
 */
export interface MutationReport {
  readonly suite: string;
  readonly candidateSha: string;
  readonly killed: number;
  readonly total: number;
  readonly survivors: readonly string[];
  readonly restoreGreen: boolean;
  readonly byCategory?: Readonly<Record<string, number>>;
  readonly mutants?: readonly MutantResult[];
}
