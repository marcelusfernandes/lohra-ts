// Issue #692: sete lugares em `src/` tinham a versão do pacote escrita à
// mão, nenhum ligado a `package.json` — todo bump que não tocasse os sete
// mentiria em `--version`, nos user-agents e no OpenAPI. `VERSION` é a
// única fonte, lida em runtime; segue o padrão de
// `commands/update-registry.ts:readInstalledVersion` (que lê o
// `package.json` já instalado, não o deste checkout).
import { createRequire } from "node:module";

/** Lê o campo `version` do `package.json` do próprio pacote, em runtime.
 * `fromUrl` é o `import.meta.url` de onde resolver `../package.json` —
 * tanto `dist/version.js` quanto `src/version.ts` ficam um nível abaixo da
 * raiz do pacote, então o caminho relativo é o mesmo nos dois casos.
 * Fail-closed: qualquer falha de leitura/parse, ou um campo `version` que
 * não seja string, vira `Error` com causa nomeada — nunca `undefined`
 * silencioso. */
export function readPackageVersion(fromUrl: string = import.meta.url): string {
  const require = createRequire(fromUrl);
  let pkg: unknown;
  try {
    pkg = require("../package.json") as unknown;
  } catch (error) {
    throw new Error(`could not read ../package.json from ${fromUrl}: ${causeMessage(error)}`, {
      cause: error,
    });
  }
  const version =
    pkg !== null && typeof pkg === "object" && "version" in pkg ? pkg.version : undefined;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`package.json has no string "version" field (read from ${fromUrl})`);
  }
  return version;
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const VERSION: string = readPackageVersion();
