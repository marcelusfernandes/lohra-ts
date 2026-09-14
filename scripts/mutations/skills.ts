// Runner de mutação dos mutantes de `src/skills/**` (issue #681). Molde de
// `doctor.ts`: único sandbox de `git archive` (via `prepareArchiveSandbox` do
// harness comum), um mutante de cada vez com
// `applyEditExactlyOnce`/`restoreAll`, classificado com `classify`, relatado
// com `writeReport`.
//
// Estado vermelho (issue #681, `test(red):`): stub que lança — o catálogo
// (`skills-mutants.ts`) ainda está vazio; o runner de verdade entra no
// commit verde.
import { ehEntryPoint } from "./harness.js";
import type { MutationReport } from "./types.js";

export function main(): MutationReport {
  throw new Error("not implemented: skills mutation runner");
}

if (ehEntryPoint(import.meta.url)) {
  try {
    const report = main();
    if (report.survivors.length > 0 || !report.restoreGreen) {
      console.error(JSON.stringify(report));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(report));
    }
  } catch (cause) {
    console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    process.exitCode = 1;
  }
}
