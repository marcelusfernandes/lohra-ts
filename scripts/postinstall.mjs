import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// npm empacota o prebuild nativo do node-pty (`spawn-helper`) sem garantir
// o bit de execução — a extração do tarball em alguns ambientes perde o
// modo original do arquivo. Sem este chmod, o terminal (tool `terminal`,
// node-pty) falha ao spawnar num pty real em QUALQUER instalação de
// consumidor (`npm install -g lohra-ts`, tarball, registry). `prepare`
// (`scripts/prepare.mjs`) não roda nessas instalações — só em checkout com
// `.git` ou dependência git (issue #530) — por isso este chmod fica em
// `postinstall`, que roda em toda instalação.
if (process.platform !== "win32") {
  const helper = join(
    process.cwd(),
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
