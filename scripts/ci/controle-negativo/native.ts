/** Opt-in Windows comparator; the ordinary negative-control path stays in run.ts. */
export function runNative(_argv: readonly string[]): never {
  throw new Error("not implemented: native negative control");
}
