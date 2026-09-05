// Regras puras do check `escopo` (issue #49): o diff da PR precisa caber
// nos globs que a `## Files` da issue declara, mais o que a PR autorizar
// explicitamente com `authorised:`. Nenhuma função aqui faz I/O — quem lê
// disco, git ou `gh` é sempre `run.ts`.
//
// Só spans em crase contam como glob, nas duas seções (issue #49, seguindo
// o precedente do Apollo #97): a versão ingênua que cortava a linha por
// vírgula e tirava as crases das pontas transformava qualquer prosa que
// dividisse linha com um glob de verdade em fragmentos de glob falsos —
// `authorised: \`a.ts\` — ver issue #43, comentário ("Esclarecendo…")`
// dividiria no vírgula e nenhum dos dois pedaços casaria com o arquivo real.

import { casa } from "../lib/globs.js";

/** Remove blocos de código (fence ```…```) do corpo ANTES de extrair
 * qualquer seção — issue #62: um exemplo dentro de um fence (`authorised:`
 * ilustrativo, ou um `## Files` de mentira colado como prosa) não pode
 * contar como diretiva real, nem truncar a extração de uma seção de
 * verdade que venha depois dele. */
function removerBlocosDeCodigo(texto: string): string {
  return texto.replace(/```[\s\S]*?```/g, "");
}

/** Resultado de `checarEscopo`. */
export interface ResultadoEscopo {
  readonly ok: boolean;
  readonly fora: readonly string[];
}

export interface ArgsChecarEscopo {
  readonly files: readonly string[];
  readonly issueGlobs: readonly string[];
  readonly authorised?: readonly string[];
}

/** Cada span entre crases na linha é um glob; o resto (prosa, pontuação) é ignorado. */
function extrairSpansEmCrase(texto: string): string[] {
  const globs: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const glob = (m[1] ?? "").trim();
    if (glob !== "") globs.push(glob);
  }
  return globs;
}

/**
 * Conteúdo entre uma linha que começa com `heading` (prefixo — aceita
 * sufixo como "(da issue #44)", que é como `open-pr.sh` renomeia a seção na
 * PR) e o próximo heading `## `. `null` se `heading` não aparece no corpo.
 */
export function extrairSecao(body: string, heading: string): string | null {
  const linhas = removerBlocosDeCodigo(body).split(/\r?\n/);
  const headingLower = heading.toLowerCase();
  const inicio = linhas.findIndex((linha) => {
    const trimmed = linha.trim();
    if (!trimmed.toLowerCase().startsWith(headingLower)) return false;
    const resto = trimmed.slice(heading.length);
    return resto === "" || /^[\s(]/.test(resto);
  });
  if (inicio === -1) return null;
  const restante = linhas.slice(inicio + 1);
  const fim = restante.findIndex((linha) => /^##\s+\S/.test(linha.trim()));
  const secao = fim === -1 ? restante : restante.slice(0, fim);
  return secao.join("\n").trim();
}

/**
 * `## Files` da issue: cada bullet (`- ...`) pode carregar um ou mais spans
 * em crase, separados por vírgula ou não. Bullet sem crase, ou linha que
 * não é bullet, é ignorado — nunca vira glob.
 */
export function globsDaIssue(issueBody: string): string[] {
  const secao = extrairSecao(issueBody, "## Files");
  if (secao === null) return [];
  const globs: string[] = [];
  for (const linhaBruta of secao.split(/\r?\n/)) {
    const bullet = /^[-*]\s+(.*)$/.exec(linhaBruta.trim());
    if (bullet === null) continue;
    globs.push(...extrairSpansEmCrase(bullet[1] ?? ""));
  }
  return globs;
}

/**
 * `## Files` da PR: só linhas `authorised:` (bullet ou soltas) concedem
 * glob — só o orquestrador escreve essa linha. Quando o valor está em
 * crase, cada span conta (igual à issue); sem crase, o primeiro token é o
 * caminho e o resto da linha é prosa (comentário, ponteiro para issue).
 */
export function globsAutorizados(prBody: string): string[] {
  const secao = extrairSecao(prBody, "## Files");
  if (secao === null) return [];
  const globs: string[] = [];
  for (const linhaBruta of secao.split(/\r?\n/)) {
    const linha = linhaBruta.trim().replace(/^[-*]\s+/, "");
    const m = /^authorised:\s*(.*)$/i.exec(linha);
    if (m === null) continue;
    const resto = (m[1] ?? "").trim();
    if (resto === "") continue;
    const comCrase = extrairSpansEmCrase(resto);
    if (comCrase.length > 0) {
      globs.push(...comCrase);
      continue;
    }
    const bare = resto.split(/\s+/)[0]?.replace(/[,;]+$/, "");
    if (bare !== undefined && bare !== "") globs.push(bare);
  }
  return globs;
}

/** `ok:false` e `fora` lista os arquivos que não casam com nenhum glob (issue + authorised). */
export function checarEscopo({
  files,
  issueGlobs,
  authorised = [],
}: ArgsChecarEscopo): ResultadoEscopo {
  const todosGlobs = [...issueGlobs, ...authorised];
  const fora = files.filter((arquivo) => !todosGlobs.some((glob) => casa(glob, arquivo)));
  return { ok: fora.length === 0, fora };
}
