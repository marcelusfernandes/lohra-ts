import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Mirrors the T12 gateway lane's failure-log shape (ADR-T12-02/ADR-T13-07):
 * a structured sink outside stdout/stderr, since those two streams are
 * byte-fixed by assertion and a console write would silently break them the
 * moment this path fired. `home` is always the caller's already-resolved
 * LOHRA_HOME — never re-resolved here — so the write stays hermetic to
 * whatever profile/home the caller is running under.
 *
 * Backs three T13 decisions with one channel (per the coordinator's
 * integration plan): assertion 41 (teardown interrupt cause), decision
 * 14/ADR-T13-04 (uncollected child failure), and ADR-T13-01 item 2
 * (privilege-escalation cause).
 */
export function logOrchestrationFailure(
  home: string,
  entry: Readonly<Record<string, unknown>>,
): void {
  const dir = join(home, "logs");
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify({ ...entry, at: Date.now() / 1000 })}\n`;
  appendFileSync(join(dir, "orchestration.log"), line, "utf8");
}
