// Issue #692: sete lugares em `src/` tinham a versão do pacote escrita à
// mão, nenhum ligado a `package.json` — todo bump que não tocasse os sete
// mentiria em `--version`, nos user-agents e no OpenAPI. `VERSION` é a
// única fonte, lida em runtime.
function notImplemented(): never {
  throw new Error("VERSION: not implemented");
}

export const VERSION: string = notImplemented();
