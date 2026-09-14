import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

import { findProjectRoot } from "../context/discovery.js";
import { realOrResolved } from "../skills/store.js";
import { toolError, toolResult } from "./envelope.js";
import type { ToolArguments } from "./types.js";

const MAX_READ_CODE_POINTS = 100_000;

// Issue #581 (épico #575, P5): `readFileTool` não recebe `project_root` como
// parâmetro — não tem contexto de sessão disponível no call site — então
// resolve o dele mesmo, a partir do cwd real do processo, como
// `loadProjectContext` já faz (`context/discovery.ts`). Um caminho que não é
// ancestral do project_root é dado potencialmente de terceiro (ex.: fora do
// repositório que o operador está de fato trabalhando, ou uma skill "home"/
// builtin fora dele) e ganha `untrusted: true` no envelope — campo aditivo,
// ausente no caso comum (arquivo ou skill dentro do projeto) para manter o
// envelope byte-compatível com quem não lê o campo (ADR de wire format
// próprio). Exportada porque `SkillTool.view` reusa o mesmo critério.
//
// Issue #642: `root` agora é parâmetro opcional — quem tem a raiz da
// SESSÃO (`SkillTool`, via `options.projectRoot`) passa a dela; sem
// argumento, o default continua sendo a raiz do processo, comportamento
// idêntico ao de antes. Caminho e raiz são medidos com `realOrResolved`
// (mesma régua tolerante a ENOENT de `src/skills/store.ts`), que segue
// symlink — `resolve()` sozinho não seguia, então um symlink DENTRO do
// projeto apontando para fora era lido como confiável, e um symlink FORA
// apontando para dentro virava `untrusted` por engano.
//
// Issue #670: `realOrResolved` devolve `null` quando o caminho real não
// pode ser estabelecido (ex.: `ELOOP` de um ciclo de symlinks) — fail
// CLOSED aqui, nunca "dentro" por padrão.
export function isUntrustedPath(
  renderedPath: string,
  root: string = findProjectRoot(process.cwd()),
): boolean {
  const resolvedPath = realOrResolved(renderedPath);
  const resolvedRoot = realOrResolved(root);
  if (resolvedPath === null || resolvedRoot === null) return true;
  const relativePath = relative(resolvedRoot, resolvedPath);
  const withinRoot =
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  return !withinRoot;
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error ? String(error.code) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

export function readFileTool(args: ToolArguments): string {
  const path = args.path;
  if (!path) return toolError("missing required argument 'path'");
  const renderedPath = renderArgument(path);
  let content: string;
  try {
    const bytes = readFileSync(renderedPath);
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return toolError(`file not found: ${renderedPath}`);
    if (code === "EISDIR") return toolError(`path is a directory: ${renderedPath}`);
    if (error instanceof TypeError && /encoded data/iu.test(error.message)) {
      return toolError(`file is not valid UTF-8 text: ${renderedPath}`);
    }
    return toolError(`could not read ${renderedPath}: ${errorMessage(error)}`);
  }
  const codePoints = Array.from(content);
  const truncated = codePoints.length > MAX_READ_CODE_POINTS;
  return toolResult(codePoints.slice(0, MAX_READ_CODE_POINTS).join(""), {
    truncated,
    path: renderedPath,
    ...(isUntrustedPath(renderedPath) ? { untrusted: true } : {}),
  });
}

export function writeFileTool(args: ToolArguments): string {
  const path = args.path;
  const content = args.content;
  if (!path) return toolError("missing required argument 'path'");
  if (content === undefined || content === null) {
    return toolError("missing required argument 'content'");
  }
  if (typeof content !== "string") return toolError("'content' must be a string");
  const renderedPath = renderArgument(path);
  try {
    mkdirSync(dirname(renderedPath), { recursive: true });
    writeFileSync(renderedPath, content, "utf8");
  } catch (error) {
    return toolError(`could not write ${renderedPath}: ${errorMessage(error)}`);
  }
  return toolResult(undefined, {
    bytes_written: Buffer.byteLength(content, "utf8"),
    path: renderedPath,
  });
}
