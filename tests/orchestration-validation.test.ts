import { describe, expect, it } from "vitest";

import { toolError } from "../src/tools/envelope.js";
import {
  coercePrompt,
  coerceTasks,
  validateCollectSubId,
  validateDelegateTasks,
  validateMaxIterations,
  validateResumeOverrides,
  validateResumeTasks,
  validateSpawnPrompt,
  validateSteerArgs,
} from "../src/orchestration/validation.js";

describe("validateSpawnPrompt", () => {
  it("rejects an empty, whitespace-only, or absent prompt", () => {
    const expected = toolError("spawn_session requires a non-empty 'prompt'");
    expect(validateSpawnPrompt({ prompt: "" })).toBe(expected);
    expect(validateSpawnPrompt({ prompt: "   " })).toBe(expected);
    expect(validateSpawnPrompt({})).toBe(expected);
  });

  it("accepts a non-empty string prompt", () => {
    expect(validateSpawnPrompt({ prompt: "do the thing" })).toBeNull();
  });

  it("accepts a numeric prompt — coerced to its string form, not rejected", () => {
    expect(validateSpawnPrompt({ prompt: 5 })).toBeNull();
  });
});

describe("coercePrompt", () => {
  it("coerces a numeric prompt via str(x).strip(), matching the oracle's coercion", () => {
    expect(coercePrompt(5)).toBe("5");
  });

  it("passes a string prompt through trimmed", () => {
    expect(coercePrompt("  hi  ")).toBe("hi");
  });
});

describe("validateSteerArgs", () => {
  it("rejects when text is absent or whitespace-only", () => {
    const expected = toolError("steer_session requires 'sub_id' and a non-empty 'text'");
    expect(validateSteerArgs({ sub_id: "abc" })).toBe(expected);
    expect(validateSteerArgs({ sub_id: "abc", text: "  " })).toBe(expected);
  });

  it("rejects when sub_id is absent", () => {
    const expected = toolError("steer_session requires 'sub_id' and a non-empty 'text'");
    expect(validateSteerArgs({ text: "hello" })).toBe(expected);
  });

  it("accepts a valid sub_id and non-empty text", () => {
    expect(validateSteerArgs({ sub_id: "abc", text: "hello" })).toBeNull();
  });
});

describe("validateCollectSubId", () => {
  it("rejects when sub_id is absent", () => {
    expect(validateCollectSubId({})).toBe(toolError("collect_session requires a 'sub_id'"));
  });

  it("accepts a present sub_id, including a non-string one (coercion happens at lookup)", () => {
    expect(validateCollectSubId({ sub_id: "abc" })).toBeNull();
    expect(validateCollectSubId({ sub_id: 7 })).toBeNull();
  });
});

describe("coerceTasks", () => {
  it("wraps a bare string into a single-element array — the oracle's coercion", () => {
    expect(coerceTasks("not a list")).toEqual(["not a list"]);
  });

  it("passes an array through unchanged", () => {
    expect(coerceTasks(["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns null for anything else", () => {
    expect(coerceTasks(undefined)).toBeNull();
    expect(coerceTasks(null)).toBeNull();
    expect(coerceTasks(42)).toBeNull();
  });
});

describe("validateDelegateTasks", () => {
  it("rejects an absent or empty task list", () => {
    const expected = toolError("'tasks' must be a non-empty list of task descriptions");
    expect(validateDelegateTasks({})).toBe(expected);
    expect(validateDelegateTasks({ tasks: [] })).toBe(expected);
  });

  it("rejects a list containing a non-empty-string violation", () => {
    const expected = toolError("each task must be a non-empty string");
    expect(validateDelegateTasks({ tasks: ["ok", "  "] })).toBe(expected);
  });

  it("accepts a bare string, coerced into a single-task list", () => {
    const result = validateDelegateTasks({ tasks: "not a list" });
    expect(result).toEqual({ tasks: ["not a list"] });
  });

  it("accepts a valid non-empty list of non-empty strings", () => {
    const result = validateDelegateTasks({ tasks: ["a", "b"] });
    expect(result).toEqual({ tasks: ["a", "b"] });
  });
});

describe("validateResumeOverrides", () => {
  it("passes through when resume_id is absent", () => {
    expect(validateResumeOverrides({})).toBeNull();
  });

  it("rejects a truthy provider override during resume", () => {
    expect(validateResumeOverrides({ resume_id: "abc", provider: "fakeprov" })).toBe(
      toolError("cannot switch provider when resuming a subagent"),
    );
  });

  it("an empty-string provider escapes the truthy check and passes — L18's documented escape", () => {
    expect(validateResumeOverrides({ resume_id: "abc", provider: "" })).toBeNull();
  });

  it("rejects max_iterations by key presence, including an explicit null", () => {
    const expected = toolError("cannot change max_iterations when resuming a subagent");
    expect(validateResumeOverrides({ resume_id: "abc", max_iterations: 5 })).toBe(expected);
    expect(validateResumeOverrides({ resume_id: "abc", max_iterations: null })).toBe(expected);
  });

  it("silently ignores model and effort during resume — not validated, not rejected here", () => {
    expect(
      validateResumeOverrides({ resume_id: "abc", model: "fake-model-b", effort: "high" }),
    ).toBeNull();
  });
});

describe("validateResumeTasks", () => {
  it("requires a non-empty follow-up instruction when resuming", () => {
    const expected = toolError("resume_id requires a follow-up instruction in 'tasks'");
    expect(validateResumeTasks({ resume_id: "abc" }, [])).toBe(expected);
    expect(validateResumeTasks({ resume_id: "abc" }, ["   "])).toBe(expected);
  });

  it("passes through when resume_id is absent, regardless of tasks", () => {
    expect(validateResumeTasks({}, [])).toBeNull();
  });

  it("accepts a non-empty follow-up instruction", () => {
    expect(validateResumeTasks({ resume_id: "abc" }, ["keep going"])).toBeNull();
  });
});

describe("validateMaxIterations", () => {
  it("passes through when omitted — inherits the default", () => {
    expect(validateMaxIterations(undefined)).toBeNull();
  });

  it("rejects null with its own distinct message", () => {
    expect(validateMaxIterations(null)).toBe(
      toolError("'max_iterations' must be a whole number between 1 and 128, not null"),
    );
  });

  it("rejects a boolean or a string with the generic whole-number message", () => {
    const expected = toolError("'max_iterations' must be a whole number between 1 and 128");
    expect(validateMaxIterations(true)).toBe(expected);
    expect(validateMaxIterations("8")).toBe(expected);
  });

  it("rejects an out-of-range integer with the 'got N' message", () => {
    expect(validateMaxIterations(0)).toBe(
      toolError("'max_iterations' must be between 1 and 128 (got 0)"),
    );
    expect(validateMaxIterations(129)).toBe(
      toolError("'max_iterations' must be between 1 and 128 (got 129)"),
    );
  });

  it("accepts an in-range integer", () => {
    expect(validateMaxIterations(1)).toBeNull();
    expect(validateMaxIterations(128)).toBeNull();
  });
});
