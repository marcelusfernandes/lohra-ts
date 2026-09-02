import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ADR-T12-02 / ADR-T13-07 (coordinator disambiguation, binding here too):
// "outside the compared surface" for the ghost-turn's causal log means
// specifically NOT stdout and NOT stderr -- it means a file under
// LOHRA_HOME or a structured sink. The dashboard's stderr is byte-fixed
// elsewhere (assertion 49/57: two lines, 0 bytes on stdout, always) -- a
// console.error here would silently break those assertions the moment this
// path fires. jobs.json (the cited precedent) is a file, not stderr.
export function logGatewayFailure(home: string, entry: Readonly<Record<string, unknown>>): void {
  const dir = join(home, "logs");
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify({ at: Date.now() / 1000, ...entry })}\n`;
  appendFileSync(join(dir, "gateway.log"), line, "utf8");
}
