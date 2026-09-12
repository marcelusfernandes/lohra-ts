// Issue #562 (M19, follow-up do veredito da PR #560): `mutations.yml` sem
// `env` do node-gyp, ordem `npm ci → npm run build → npm run pack:check` no
// job `pack-check` (o `build` é o único produtor de `dist/` no tarball) e
// comentário citando os dois caches (`_prebuilds`, `_cacache`) que o
// consumidor offline precisa. O teste pina a forma dos workflows.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-pack-check-job.test.ts"],
} satisfies Declaracao;
