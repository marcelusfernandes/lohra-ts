import { describe, expect, it } from "vitest";

import { CronValidationError } from "../src/cron/errors.js";
import { validateJob } from "../src/cron/validate.js";

describe("validateJob", () => {
  it("rejects empty or whitespace-only name/prompt with the exact oracle text", () => {
    expect(() => {
      validateJob("", "p", "interval", 5);
    }).toThrow(new CronValidationError("a job needs a non-empty 'name'"));
    expect(() => {
      validateJob("   ", "p", "interval", 5);
    }).toThrow("a job needs a non-empty 'name'");
    expect(() => {
      validateJob("n", "", "interval", 5);
    }).toThrow("a job needs a non-empty 'prompt'");
    expect(() => {
      validateJob("n", "   ", "interval", 5);
    }).toThrow("a job needs a non-empty 'prompt'");
  });

  it("rejects an unknown job type", () => {
    expect(() => {
      validateJob("n", "p", "daily", 5);
    }).toThrow('unknown job type "daily" (use once/interval/cron)');
  });

  it("interval must be a positive number", () => {
    expect(() => {
      validateJob("n", "p", "interval", 0);
    }).toThrow("'interval' value must be minutes > 0");
    expect(() => {
      validateJob("n", "p", "interval", -5);
    }).toThrow("'interval' value must be minutes > 0");
    expect(() => {
      validateJob("n", "p", "interval", "5");
    }).toThrow("'interval' value must be minutes > 0");
    expect(() => {
      validateJob("n", "p", "interval", 5);
    }).not.toThrow();
  });

  it("once must be numeric, but NaN/Infinity/-1 are all accepted — reproduces the ghost-job vector", () => {
    expect(() => {
      validateJob("n", "p", "once", "tomorrow");
    }).toThrow("'once' value must be a run-at epoch timestamp");
    expect(() => {
      validateJob("n", "p", "once", NaN);
    }).not.toThrow();
    expect(() => {
      validateJob("n", "p", "once", Number.POSITIVE_INFINITY);
    }).not.toThrow();
    expect(() => {
      validateJob("n", "p", "once", -1);
    }).not.toThrow();
  });

  it("cron expression is validated via cronMatches, wrapped with a prefix", () => {
    expect(() => {
      validateJob("n", "p", "cron", "* * * *");
    }).toThrow('invalid cron expression: cron expression needs 5 fields, got 4: "* * * *"');
    expect(() => {
      validateJob("n", "p", "cron", "60 * * * *");
    }).toThrow('invalid cron expression: cron field out of range: "60"');
    expect(() => {
      validateJob("n", "p", "cron", "0 0 * * 7");
    }).not.toThrow();
  });
});
