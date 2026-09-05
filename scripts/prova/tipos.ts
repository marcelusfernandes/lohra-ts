// Tipos do contrato `prova/<slug>.ts` e das estruturas puras usadas por
// `slug.ts`, `resumo.ts` e `vitest-relatorio.ts` (issue #42). Nenhum tipo
// aqui depende de I/O; quem lê disco é sempre `run.ts`.

/** O que cada `prova/<slug>.ts` exporta por default. */
export interface Declaracao {
  /** Caminhos de teste, relativos à raiz do repo, que a issue declara. */
  readonly unit: readonly string[];
  /** Se `true`, `run.ts` roda `npm run typecheck` antes do vitest. */
  readonly check?: boolean;
}

/** Um teste individual, já normalizado a partir do relatório do vitest. */
export interface ResultadoTeste {
  readonly nome: string;
  readonly passou: boolean;
  readonly motivo?: string;
}

/** Um arquivo de teste executado, já normalizado (caminho relativo à raiz). */
export interface ResultadoArquivo {
  readonly arquivo: string;
  /** `false` quando o arquivo falhou ao ser coletado (import inválido etc). */
  readonly colecionou: boolean;
  readonly motivoColeta?: string;
  readonly testes: readonly ResultadoTeste[];
}

/** Forma normalizada do relatório do vitest — o que `montarResumo` lê. */
export interface ResultadoVitest {
  readonly total: number;
  readonly arquivos: readonly ResultadoArquivo[];
}

export interface Falha {
  readonly nome: string;
  readonly motivo: string;
}

/** O `resumo.json` — exatamente estas três chaves. */
export interface Resumo {
  readonly ok: boolean;
  readonly total: number;
  readonly falhas: readonly Falha[];
}
