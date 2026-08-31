import { describe, expect, it } from "vitest";

import { cronMatches, isDue, parseCronField } from "../src/cron/schedule.js";

describe("parseCronField", () => {
  it("expands *, single, range, comma-list, and step", () => {
    expect(parseCronField("*", 0, 4)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(parseCronField("3", 0, 59)).toEqual(new Set([3]));
    expect(parseCronField("2-4", 0, 59)).toEqual(new Set([2, 3, 4]));
    expect(parseCronField("1,3,5", 0, 59)).toEqual(new Set([1, 3, 5]));
    expect(parseCronField("*/15", 0, 59)).toEqual(new Set([0, 15, 30, 45]));
  });

  it("rejects out-of-range bounds with the byte-exact message", () => {
    expect(() => parseCronField("60", 0, 59)).toThrow("cron field out of range: '60'");
    expect(() => parseCronField("*/0", 0, 59)).toThrow("cron field out of range: '*/0'");
    expect(() => parseCronField("5-1", 0, 59)).toThrow("cron field out of range: '5-1'");
  });

  it("rejects non-numeric parts with CPython's int() wording (named excuse)", () => {
    expect(() => parseCronField("a", 0, 59)).toThrow(
      "invalid literal for int() with base 10: 'a'",
    );
    expect(() => parseCronField("1,,2", 0, 59)).toThrow(
      "invalid literal for int() with base 10: ''",
    );
  });
});

describe("cronMatches", () => {
  it("requires exactly 5 whitespace-separated fields", () => {
    expect(() => cronMatches("* * * *", new Date())).toThrow(
      "cron expression needs 5 fields, got 4: '* * * *'",
    );
    expect(() => cronMatches("* * * * * *", new Date())).toThrow(
      "cron expression needs 5 fields, got 6: '* * * * * *'",
    );
  });

  it("matches minute/hour/day/month/weekday against local time", () => {
    // 2026-01-15 is a Thursday; local weekday index (Sun=0) is 4.
    const when = new Date(2026, 0, 15, 14, 30, 0);
    expect(cronMatches("30 14 15 1 4", when)).toBe(true);
    expect(cronMatches("31 14 15 1 4", when)).toBe(false);
    expect(cronMatches("* * * * *", when)).toBe(true);
  });

  it("accepts both 0 and 7 as Sunday in the weekday field", () => {
    // 2026-01-04 is a Sunday.
    const sunday = new Date(2026, 0, 4, 0, 0, 0);
    expect(cronMatches("0 0 * * 0", sunday)).toBe(true);
    expect(cronMatches("0 0 * * 7", sunday)).toBe(true);
    expect(cronMatches("0 0 * * 1", sunday)).toBe(false);
  });

  it("never uses UTC-derived fields — a TZ change alone flips the match", () => {
    const epochSeconds = Date.UTC(2026, 0, 1, 23, 30, 0) / 1000;
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utcDay = new Date(epochSeconds * 1000).getDate();
      process.env.TZ = "Pacific/Kiritimati";
      const kiritimatiDay = new Date(epochSeconds * 1000).getDate();
      expect(kiritimatiDay).not.toBe(utcDay);
      expect(
        cronMatches(`* * ${String(kiritimatiDay)} * *`, new Date(epochSeconds * 1000)),
      ).toBe(true);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe("isDue", () => {
  it("disabled jobs are never due", () => {
    expect(isDue({ enabled: false, type: "once", value: 0 }, { now: 1000 })).toBe(false);
  });

  it("once: due only once last_run_at is null and now has passed value", () => {
    expect(isDue({ type: "once", value: 100, last_run_at: null }, { now: 100 })).toBe(true);
    expect(isDue({ type: "once", value: 100, last_run_at: null }, { now: 99 })).toBe(false);
    expect(isDue({ type: "once", value: 100, last_run_at: 100 }, { now: 200 })).toBe(false);
  });

  it("interval: fires immediately when last_run_at is null, else after the period", () => {
    expect(isDue({ type: "interval", value: 5, last_run_at: null }, { now: 1000 })).toBe(true);
    expect(isDue({ type: "interval", value: 5, last_run_at: 1000 }, { now: 1299 })).toBe(false);
    expect(isDue({ type: "interval", value: 5, last_run_at: 1000 }, { now: 1300 })).toBe(true);
  });

  it("once/interval are immune to timezone — pure epoch arithmetic", () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utcDue = isDue({ type: "once", value: 100, last_run_at: null }, { now: 100 });
      process.env.TZ = "Pacific/Kiritimati";
      const kirDue = isDue({ type: "once", value: 100, last_run_at: null }, { now: 100 });
      expect(utcDue).toBe(kirDue);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("once: NaN value never becomes due — the ghost-job vector (`--at nan`)", () => {
    expect(isDue({ type: "once", value: NaN, last_run_at: null }, { now: 1000 })).toBe(false);
    // Comparisons with NaN are always false, at any `now` — the job is permanently unreachable,
    // not merely due-in-the-far-future.
    expect(
      isDue({ type: "once", value: NaN, last_run_at: null }, { now: Number.MAX_SAFE_INTEGER }),
    ).toBe(false);
  });

  it("cron: minute-floor guard prevents double-fire within the same wall-clock minute", () => {
    const when = new Date(2026, 0, 15, 14, 30, 20);
    const now = when.getTime() / 1000;
    const minuteFloorNow = now - (now % 60);
    expect(
      isDue(
        { type: "cron", value: "30 14 * * *", last_run_at: minuteFloorNow },
        { now },
      ),
    ).toBe(false);
    expect(
      isDue(
        { type: "cron", value: "30 14 * * *", last_run_at: minuteFloorNow - 60 },
        { now },
      ),
    ).toBe(true);
  });

  it("throws for an unknown job type", () => {
    expect(() => isDue({ type: "bogus", value: 0 }, { now: 0 })).toThrow(
      "unknown job type 'bogus'",
    );
  });
});
