// Issue #4 — `lohra dashboard` ganha `--host` (encaminhado ao bind real,
// default `127.0.0.1`) e `--no-open` (aceito, no-op documentado). `--host`
// fora de loopback (127.0.0.1, localhost, ::1) combinado com `--insecure` é
// recusado com erro próprio da CLI, concretizando a reavaliação do gatilho
// L22 registrada em `docs/gate-decision.md`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/dashboard-host.test.ts"],
} satisfies Declaracao;
