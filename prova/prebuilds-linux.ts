// Issue #549: decisão (a) — node-pty@1.1.0 (pin anterior) só publica
// prebuilds darwin-*/win32-*, nunca linux-*; a instalação em Linux sempre
// caía no fallback `node-gyp rebuild`. `npm view node-pty@<v> dist.tarball` +
// `npm pack node-pty@<v> --pack-destination <mkdtemp>` (investigação na PR)
// mostrou que `linux-x64`/`linux-arm64` só aparecem a partir de
// `1.2.0-beta.8` — nenhuma versão estável ≥1.1.0 os publica — e continuam em
// `1.2.0-beta.15`, a mais recente disponível, daí o pin exato. A API usada
// por `src/tools/terminal.ts` (`spawn`/`onData`/`onExit`/`kill`) é idêntica
// entre as duas versões (typings/node-pty.d.ts, comparação manual).
//
// `tests/pack-check.test.ts` prende o pin exato (reversão futura para
// qualquer versão sem prebuild Linux reprova aqui, sem gastar tempo com
// `npm run pack:check`); `scripts/pack-check.ts`/`assertNoNativeCompileNeeded`
// já eram genéricos por plataforma/arquitetura antes desta issue (issue
// #532) — nenhuma mudança de produção foi necessária além do bump em
// `package.json`/`package-lock.json`. `npm run pack:check` (fora deste
// harness — precisa empacotar e instalar de verdade) é a prova de ponta a
// ponta em macOS; a prova de Linux está documentada no test plan da PR
// (container `node:20`/`node:22` quando `docker` está disponível, ou nota
// explícita de que fica para o CI quando não está).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/pack-check.test.ts"],
} satisfies Declaracao;
