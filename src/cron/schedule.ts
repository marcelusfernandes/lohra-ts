/**
 * Cron schedule computation — pure, clock-injected. Ports lohra/backend/lohra/cron/schedule.py.
 *
 * `when` uses local-time Date getters throughout (never `getUTC*`/`toISOString`), matching the
 * oracle's `datetime.fromtimestamp(now)`, which resolves in the process's local timezone (the
 * `TZ` environment variable). This is a deliberate, measured divergence from T08/T10 (which pin
 * `TZ=UTC`): the mechanism does not control its own timezone, and this port reproduces that.
 */

const FIELD_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/**
 * Mirrors Python's `int(s)` conversion and its exact ValueError text on failure — the "named
 * excuse" class (CPython's own wording), distinct from the byte-exact "cron field out of range"
 * class that only fires once every int() call in the field has already succeeded.
 */
function pythonInt(text: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(text)}`);
  }
  return Number.parseInt(trimmed, 10);
}

export function parseCronField(field: string, low: number, high: number): Set<number> {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    let part = rawPart;
    let step = 1;
    if (part.includes("/")) {
      const [base, stepText] = part.split("/", 2) as [string, string];
      part = base;
      step = pythonInt(stepText);
    }
    let start: number;
    let end: number;
    if (part === "*") {
      start = low;
      end = high;
    } else if (part.includes("-")) {
      const [startText, endText] = part.split("-", 2) as [string, string];
      start = pythonInt(startText);
      end = pythonInt(endText);
    } else {
      start = pythonInt(part);
      end = start;
    }
    if (start < low || end > high || start > end || step < 1) {
      throw new Error(`cron field out of range: ${JSON.stringify(field)}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Whether `expr` (5 fields) fires at `when` (cron day-of-week 0=Sunday, matching Date#getDay). */
export function cronMatches(expr: string, when: Date): boolean {
  const fields = expr.split(/\s+/).filter((part) => part.length > 0);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression needs 5 fields, got ${String(fields.length)}: ${JSON.stringify(expr)}`,
    );
  }
  // Date#getDay() is already 0=Sunday..6=Saturday, the same convention the oracle derives via
  // `when.isoweekday() % 7` — no transformation needed.
  const weekday = when.getDay();
  const localValues = [when.getMinutes(), when.getHours(), when.getDate(), when.getMonth() + 1];
  for (let index = 0; index < 5; index += 1) {
    const [low, high] = FIELD_BOUNDS[index] as [number, number];
    const allowed = parseCronField(fields[index] as string, low, high);
    const matches =
      index === 4
        ? allowed.has(weekday) || (weekday === 0 && allowed.has(7))
        : allowed.has(localValues[index] as number);
    if (!matches) return false;
  }
  return true;
}

function minuteFloor(epoch: number): number {
  return epoch - (epoch % 60);
}

export interface CronJobLike {
  readonly enabled?: boolean;
  readonly type?: string;
  readonly value?: unknown;
  readonly last_run_at?: number | null;
}

/**
 * A `once` job whose value is `NaN`/`Infinity` can never satisfy `now >= value` (assertion 28) —
 * this is a distinct, permanent condition from "not due yet", used only to decide whether to emit
 * a diagnostic (never stdout/stderr, decision 7), not to change `isDue`'s own comparison logic.
 */
export function isPermanentlyUnreachable(job: CronJobLike): boolean {
  return job.type === "once" && !Number.isFinite(Number(job.value));
}

export function isDue(job: CronJobLike, options: { readonly now: number }): boolean {
  if (job.enabled === false) return false;
  const { now } = options;
  const lastRun = job.last_run_at ?? null;
  if (job.type === "once") {
    return lastRun === null && now >= Number(job.value);
  }
  if (job.type === "interval") {
    if (lastRun === null) return true;
    return now - lastRun >= Number(job.value) * 60;
  }
  if (job.type === "cron") {
    if (!cronMatches(String(job.value), new Date(now * 1000))) return false;
    return lastRun === null || lastRun < minuteFloor(now);
  }
  const cited = job.type === undefined ? "undefined" : JSON.stringify(job.type);
  throw new Error(`unknown job type ${cited}`);
}
