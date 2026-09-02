/** A bad job definition — surfaced to the caller (tool/CLI). Ports `store.py`'s `CronError`. */
export class CronValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CronValidationError";
  }
}

/**
 * The store's `jobs.json` cannot be trusted — fail-closed per the closed ADR
 * (adr-cron-corrupt-store). A deliberate, narrow divergence from the oracle: the oracle degrades
 * 13 of these forms to an empty list and crashes on 4 more; this port collapses all of them into
 * one stable, typed, visible failure that never destroys the file's bytes. Never carries the raw
 * file content (only the path and a safe cause), since the content may be sensitive.
 */
export class CronStoreError extends Error {
  public constructor(
    public readonly path: string,
    public readonly safeCause: string,
  ) {
    super(
      `cron store at ${path} is unreadable (${safeCause}) — move or repair the file and try again`,
    );
    this.name = "CronStoreError";
  }
}
