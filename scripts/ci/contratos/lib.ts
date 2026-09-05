// Regras de contrato do CI (issue #50): três invariantes do CLAUDE.md
// aplicados aos arquivos de um diff. Puro — quem lê disco/git é `run.ts`.
//
// Auto-exclusão da regra `import-proibido`: `scripts/ci/**` (este próprio
// diretório — as definições dos padrões abaixo contêm as strings
// "python-json"/"python-repr" como dado) e `tests/ci-*.test.ts` (os testes
// de CI constroem fixtures com imports proibidos, como string, para provar
// que o scanner os pega — nenhum dos dois é o invariante em si, e escaneá-los
// faria o contrato tropeçar na própria definição).

export interface Violacao {
  readonly id: string;
  readonly arquivo: string;
  readonly descricao: string;
}

export interface Regra {
  readonly id: string;
  readonly descreve: string;
  avalia(arquivo: string, conteudo: string | null): Violacao | null;
}

const PREFIXOS_PROIBIDOS = ["docs/reference/", "lohra/"];

function comBarraFinal(prefixo: string): string {
  return prefixo.endsWith("/") ? prefixo : `${prefixo}/`;
}

function sobPrefixo(arquivo: string, prefixo: string): boolean {
  return arquivo.startsWith(comBarraFinal(prefixo));
}

const caminhoProibido: Regra = {
  id: "caminho-proibido",
  descreve: "Caminho sob docs/reference/ ou lohra/ — histórico, não editável (CLAUDE.md).",
  avalia(arquivo) {
    const prefixo = PREFIXOS_PROIBIDOS.find((p) => sobPrefixo(arquivo, p));
    if (prefixo === undefined) return null;
    return {
      id: "caminho-proibido",
      arquivo,
      descricao: `sob ${prefixo} (histórico, não editável)`,
    };
  },
};

// Specifiers de import/require/import() dinâmico — não uma menção solta em
// comentário ou prosa. Os quatro padrões cobrem `import ... from "x"`,
// `import "x"`, `require("x")` e `import("x")`.
const PADROES_IMPORT = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function extrairSpecifiersDeImport(conteudo: string): readonly string[] {
  const specifiers: string[] = [];
  for (const padrao of PADROES_IMPORT) {
    padrao.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = padrao.exec(conteudo)) !== null) {
      const specifier = m[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Exportado para `run.ts` filtrar por id sem duplicar a string literal. */
export const ID_IMPORT_PROIBIDO = "import-proibido";

const ESCOPO_IMPORT_PROIBIDO = ["src/", "scripts/", "tests/"];
const PREFIXO_AUTOEXCLUSAO = "scripts/ci/";
const ARQUIVO_TESTE_CI_RE = /^tests\/ci-[^/]+\.test\.ts$/;
const MODULOS_PROIBIDOS = ["python-json", "python-repr"];

function noEscopoDeImportProibido(arquivo: string): boolean {
  if (sobPrefixo(arquivo, PREFIXO_AUTOEXCLUSAO)) return false;
  if (ARQUIVO_TESTE_CI_RE.test(arquivo)) return false;
  return ESCOPO_IMPORT_PROIBIDO.some((prefixo) => sobPrefixo(arquivo, prefixo));
}

const importProibido: Regra = {
  id: ID_IMPORT_PROIBIDO,
  descreve:
    "Import/require de python-json ou python-repr em src/**, scripts/** ou tests/** " +
    "(exceto scripts/ci/** e tests/ci-*.test.ts) — módulos removidos pela #17.",
  avalia(arquivo, conteudo) {
    if (conteudo === null) return null;
    if (!noEscopoDeImportProibido(arquivo)) return null;
    const specifiers = extrairSpecifiersDeImport(conteudo).filter((specifier) =>
      MODULOS_PROIBIDOS.some((modulo) => specifier.includes(modulo)),
    );
    if (specifiers.length === 0) return null;
    return {
      id: ID_IMPORT_PROIBIDO,
      arquivo,
      descricao: `importa ${specifiers.join(", ")}`,
    };
  },
};

const EXTENSOES_ARQUIVO_GRANDE = [".ts", ".mjs", ".sh", ".md"];
const LIMITE_LINHAS = 800;
const EXCECOES_ARQUIVO_GRANDE = ["tests/fixtures/", "docs/reference/"];

function contarLinhas(conteudo: string): number {
  if (conteudo === "") return 0;
  const partes = conteudo.split("\n");
  // `conteudo` terminado em "\n" produz um último elemento vazio de split —
  // não é uma linha a mais.
  const ultimo = partes[partes.length - 1];
  return ultimo === "" ? partes.length - 1 : partes.length;
}

const arquivoGrande: Regra = {
  id: "arquivo-grande",
  descreve: `Arquivo .ts/.mjs/.sh/.md com mais de ${String(LIMITE_LINHAS)} linhas.`,
  avalia(arquivo, conteudo) {
    if (conteudo === null) return null;
    if (!EXTENSOES_ARQUIVO_GRANDE.some((ext) => arquivo.endsWith(ext))) return null;
    if (EXCECOES_ARQUIVO_GRANDE.some((prefixo) => sobPrefixo(arquivo, prefixo))) return null;
    const linhas = contarLinhas(conteudo);
    if (linhas <= LIMITE_LINHAS) return null;
    return {
      id: "arquivo-grande",
      arquivo,
      descricao: `${String(linhas)} linhas (> ${String(LIMITE_LINHAS)})`,
    };
  },
};

export const regras: readonly Regra[] = [caminhoProibido, importProibido, arquivoGrande];

/**
 * Aplica todas as `regras` a todos os `files`, agregando as violações. Puro:
 * `lerConteudo` é injetado por quem chama (`run.ts` lê disco/git).
 */
export function rodarContratos(
  files: readonly string[],
  lerConteudo: (arquivo: string) => string | null,
): readonly Violacao[] {
  const violacoes: Violacao[] = [];
  for (const arquivo of files) {
    const conteudo = lerConteudo(arquivo);
    for (const regra of regras) {
      const violacao = regra.avalia(arquivo, conteudo);
      if (violacao !== null) violacoes.push(violacao);
    }
  }
  return violacoes;
}
