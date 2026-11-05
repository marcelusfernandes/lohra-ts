// Issue #977 (S1, épico #976): predicados mecânicos sobre o estado do run.
// `evaluatePredicate` segue a tabela do desenho §4 (nove predicados, avaliação
// total, `default` lança); `validatePredicate` recusa cada caso do §4 com um
// `SpecIssue` que traz rule, field e exemplo; `readPath` é a camada fina sobre
// `lookup` que lê o mesmo valor que `${ref}` renderiza.
import { describe, expect, it } from "vitest";

import {
  evaluatePredicate,
  MAX_PREDICATE_VALUES,
  PREDICATE_NAMES,
  PREDICATE_TYPES,
  validatePredicate,
  type Predicate,
} from "../src/workflow/predicates.js";
import { InvalidReferenceError, readPath, resolveValue } from "../src/workflow/refs.js";

const CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({
  args: { topic: "t", n: 3 },
  scan: {
    score: 8.5,
    label: "ok",
    flag: true,
    count: 0,
    items: [10, 20, 30],
    meta: {},
    blank: "",
    nothing: null,
    nested: { deep: { deeper: "d" } },
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    text: "abc",
    stringified: "8.5",
  },
  blob: '{"score": 7, "tags": ["a", "b"], "inner": {"k": "v"}, "none": []}',
  fenced: 'prose first\n```json\n{"x": 1}\n```\nprose after',
  list: [{ id: "a" }, { id: "b" }],
  failed: null,
});

const p = (path: string): string => `\${${path}}`;

describe("PREDICATE_NAMES (§4)", () => {
  it("lists exactly the nine predicates of the table", () => {
    expect([...PREDICATE_NAMES]).toEqual([
      "field_equals",
      "field_true",
      "in",
      "gte",
      "lt",
      "count_gte",
      "empty",
      "field_type",
      "not",
    ]);
    expect([...PREDICATE_TYPES]).toEqual([
      "number",
      "string",
      "boolean",
      "array",
      "object",
      "null",
    ]);
    expect(MAX_PREDICATE_VALUES).toBe(64);
  });
});

describe("readPath — the thin layer over lookup (#977)", () => {
  const FIXTURES = [
    "args.topic",
    "args.n",
    "args",
    "scan.score",
    "scan.items",
    "scan.items.0",
    "scan.items.1",
    "scan.items.7",
    "scan.items.١", // Arabic-Indic digit one: lookup accepts any \p{Nd} index
    "scan.meta",
    "scan.nothing",
    "scan.missing",
    "scan.missing.deeper",
    "scan.nested.deep.deeper",
    "scan.label.x",
    "scan.text.x",
    "blob.score",
    "blob.tags",
    "blob.tags.1",
    "blob.tags.9",
    "blob.inner.k",
    "blob.nope",
    "fenced.x",
    "list.0.id",
    "list.1.id",
    "list.9.id",
    "failed",
    "failed.x",
    "ghost",
    "ghost.a.b",
  ];

  it.each(FIXTURES)("reads %s exactly as ${ref} renders it", (reference) => {
    expect(readPath(reference, CONTEXT)).toEqual(resolveValue(p(reference), CONTEXT));
  });

  it("an absent field is null, never undefined", () => {
    expect(readPath("scan.missing", CONTEXT)).toBeNull();
    expect(readPath("ghost.a.b", CONTEXT)).toBeNull();
    expect(readPath("scan.items.7", CONTEXT)).toBeNull();
  });

  it("traverses a JSON string and an array index", () => {
    expect(readPath("blob.score", CONTEXT)).toBe(7);
    expect(readPath("blob.tags.1", CONTEXT)).toBe("b");
    expect(readPath("scan.items.2", CONTEXT)).toBe(30);
    expect(readPath("list.1.id", CONTEXT)).toBe("b");
  });

  it.each(["", " a", "a b", "a+b", ".a", "a.", "a..b", "a-b", "a(b)"])(
    "refuses the invalid reference %j the way ${ref} does",
    (reference) => {
      expect(() => resolveValue(p(reference), CONTEXT)).toThrow(InvalidReferenceError);
      expect(() => readPath(reference, CONTEXT)).toThrow(InvalidReferenceError);
    },
  );
});

describe("evaluatePredicate — the table of §4", () => {
  const holds = (predicate: Predicate): boolean => evaluatePredicate(predicate, CONTEXT);

  describe("field_equals", () => {
    it("holds on strict equality of the read value and the operand", () => {
      expect(holds({ field_equals: { path: p("scan.label"), value: "ok" } })).toBe(true);
      expect(holds({ field_equals: { path: p("scan.score"), value: 8.5 } })).toBe(true);
      expect(holds({ field_equals: { path: p("scan.flag"), value: true } })).toBe(true);
    });

    it("does not coerce: 8.5 is not '8.5', 0 is not false", () => {
      expect(holds({ field_equals: { path: p("scan.score"), value: "8.5" } })).toBe(false);
      expect(holds({ field_equals: { path: p("scan.stringified"), value: 8.5 } })).toBe(false);
      expect(holds({ field_equals: { path: p("scan.count"), value: false } })).toBe(false);
      expect(holds({ field_equals: { path: p("scan.label"), value: "bad" } })).toBe(false);
    });

    it("an absent field reads null: it equals null and nothing else", () => {
      expect(holds({ field_equals: { path: p("scan.missing"), value: null } })).toBe(true);
      expect(holds({ field_equals: { path: p("scan.missing"), value: "" } })).toBe(false);
      expect(holds({ field_equals: { path: p("scan.missing"), value: 0 } })).toBe(false);
    });

    it("reads through a JSON string and an array index", () => {
      expect(holds({ field_equals: { path: p("blob.score"), value: 7 } })).toBe(true);
      expect(holds({ field_equals: { path: p("blob.tags.0"), value: "a" } })).toBe(true);
      expect(holds({ field_equals: { path: p("list.1.id"), value: "b" } })).toBe(true);
      expect(holds({ field_equals: { path: p("list.1.id"), value: "a" } })).toBe(false);
    });
  });

  describe("field_true", () => {
    it("holds only for the boolean true", () => {
      expect(holds({ field_true: { path: p("scan.flag") } })).toBe(true);
      expect(holds({ field_true: { path: p("scan.label") } })).toBe(false);
      expect(holds({ field_true: { path: p("scan.score") } })).toBe(false);
      expect(holds({ field_true: { path: p("scan.count") } })).toBe(false);
    });

    it("an absent field is not true", () => {
      expect(holds({ field_true: { path: p("scan.missing") } })).toBe(false);
      expect(holds({ field_true: { path: p("ghost.a") } })).toBe(false);
    });
  });

  describe("in", () => {
    it("holds when a scalar read value is one of the operands", () => {
      expect(holds({ in: { path: p("scan.label"), values: ["ok", "good"] } })).toBe(true);
      expect(holds({ in: { path: p("scan.label"), values: ["bad", "worse"] } })).toBe(false);
      expect(holds({ in: { path: p("scan.score"), values: [1, 8.5] } })).toBe(true);
      expect(holds({ in: { path: p("scan.flag"), values: [false] } })).toBe(false);
    });

    it("a value that is not a scalar is never in the list", () => {
      expect(holds({ in: { path: p("scan.items"), values: ["x"] } })).toBe(false);
      expect(holds({ in: { path: p("scan.meta"), values: ["x"] } })).toBe(false);
    });

    it("an absent field reads null, so only a null operand matches it", () => {
      expect(holds({ in: { path: p("scan.missing"), values: ["a", "b"] } })).toBe(false);
      expect(holds({ in: { path: p("scan.missing"), values: ["a", null] } })).toBe(true);
    });

    it("reads through a JSON string and an array index", () => {
      expect(holds({ in: { path: p("blob.tags.1"), values: ["b", "c"] } })).toBe(true);
      expect(holds({ in: { path: p("scan.items.0"), values: [10, 11] } })).toBe(true);
    });
  });

  describe("gte and lt", () => {
    it("compare a finite number with n, inclusive for gte and exclusive for lt", () => {
      expect(holds({ gte: { path: p("scan.score"), n: 8 } })).toBe(true);
      expect(holds({ gte: { path: p("scan.score"), n: 8.5 } })).toBe(true);
      expect(holds({ gte: { path: p("scan.score"), n: 9 } })).toBe(false);
      expect(holds({ lt: { path: p("scan.score"), n: 9 } })).toBe(true);
      expect(holds({ lt: { path: p("scan.score"), n: 8.5 } })).toBe(false);
      expect(holds({ lt: { path: p("scan.score"), n: 8 } })).toBe(false);
    });

    it("a non-number never compares, in either direction", () => {
      for (const path of [
        "scan.stringified",
        "scan.label",
        "scan.flag",
        "scan.items",
        "scan.meta",
      ]) {
        expect(holds({ gte: { path: p(path), n: -1e9 } })).toBe(false);
        expect(holds({ lt: { path: p(path), n: 1e9 } })).toBe(false);
      }
    });

    it("an absent field (null) never compares", () => {
      expect(holds({ gte: { path: p("scan.missing"), n: 0 } })).toBe(false);
      expect(holds({ lt: { path: p("scan.missing"), n: 1 } })).toBe(false);
      expect(holds({ lt: { path: p("scan.nothing"), n: 1 } })).toBe(false);
    });

    it("NaN and Infinity are not finite numbers", () => {
      expect(holds({ gte: { path: p("scan.inf"), n: 0 } })).toBe(false);
      expect(holds({ lt: { path: p("scan.inf"), n: 1e308 } })).toBe(false);
      expect(holds({ gte: { path: p("scan.nan"), n: 0 } })).toBe(false);
      expect(holds({ lt: { path: p("scan.nan"), n: 0 } })).toBe(false);
    });

    it("reads through a JSON string and an array index", () => {
      expect(holds({ gte: { path: p("blob.score"), n: 7 } })).toBe(true);
      expect(holds({ lt: { path: p("blob.score"), n: 7 } })).toBe(false);
      expect(holds({ gte: { path: p("scan.items.2"), n: 30 } })).toBe(true);
    });
  });

  describe("count_gte", () => {
    it("holds when the read value is an array of at least n items", () => {
      expect(holds({ count_gte: { path: p("scan.items"), n: 3 } })).toBe(true);
      expect(holds({ count_gte: { path: p("scan.items"), n: 4 } })).toBe(false);
      expect(holds({ count_gte: { path: p("scan.items"), n: 0 } })).toBe(true);
      expect(holds({ count_gte: { path: p("list"), n: 2 } })).toBe(true);
    });

    it("only an array counts: a string, an object or a number never does", () => {
      expect(holds({ count_gte: { path: p("scan.text"), n: 0 } })).toBe(false);
      expect(holds({ count_gte: { path: p("scan.meta"), n: 0 } })).toBe(false);
      expect(holds({ count_gte: { path: p("scan.score"), n: 0 } })).toBe(false);
      expect(holds({ count_gte: { path: p("blob"), n: 0 } })).toBe(false);
    });

    it("an absent field is not an array", () => {
      expect(holds({ count_gte: { path: p("scan.missing"), n: 0 } })).toBe(false);
    });

    it("reads through a JSON string", () => {
      expect(holds({ count_gte: { path: p("blob.tags"), n: 2 } })).toBe(true);
      expect(holds({ count_gte: { path: p("blob.tags"), n: 3 } })).toBe(false);
      expect(holds({ count_gte: { path: p("blob.none"), n: 1 } })).toBe(false);
    });
  });

  describe("empty", () => {
    it("holds for absent, null, an empty string, an empty array and an empty object", () => {
      expect(holds({ empty: { path: p("scan.missing") } })).toBe(true);
      expect(holds({ empty: { path: p("scan.nothing") } })).toBe(true);
      expect(holds({ empty: { path: p("failed") } })).toBe(true);
      expect(holds({ empty: { path: p("scan.blank") } })).toBe(true);
      expect(holds({ empty: { path: p("scan.meta") } })).toBe(true);
      expect(holds({ empty: { path: p("blob.none") } })).toBe(true);
    });

    it("does not hold for 0, false, a filled string, array or object", () => {
      expect(holds({ empty: { path: p("scan.count") } })).toBe(false);
      expect(holds({ empty: { path: p("scan.flag") } })).toBe(false);
      expect(holds({ empty: { path: p("scan.label") } })).toBe(false);
      expect(holds({ empty: { path: p("scan.items") } })).toBe(false);
      expect(holds({ empty: { path: p("scan.nested") } })).toBe(false);
    });
  });

  describe("field_type", () => {
    it("names the JSON type of the read value", () => {
      const types: readonly (readonly [string, string])[] = [
        ["scan.score", "number"],
        ["scan.count", "number"],
        ["scan.label", "string"],
        ["scan.blank", "string"],
        ["scan.flag", "boolean"],
        ["scan.items", "array"],
        ["scan.meta", "object"],
        ["scan.nested", "object"],
        ["scan.nothing", "null"],
      ];
      for (const [path, type] of types) {
        expect(
          holds({ field_type: { path: p(path), type: type as "number" } }),
          `${path} is ${type}`,
        ).toBe(true);
      }
    });

    it("an absent field is of type null, and nothing else", () => {
      expect(holds({ field_type: { path: p("scan.missing"), type: "null" } })).toBe(true);
      expect(holds({ field_type: { path: p("ghost.a"), type: "null" } })).toBe(true);
      expect(holds({ field_type: { path: p("scan.missing"), type: "string" } })).toBe(false);
      expect(holds({ field_type: { path: p("scan.missing"), type: "object" } })).toBe(false);
    });

    it("distinguishes every pair of types", () => {
      expect(holds({ field_type: { path: p("scan.items"), type: "object" } })).toBe(false);
      expect(holds({ field_type: { path: p("scan.meta"), type: "array" } })).toBe(false);
      expect(holds({ field_type: { path: p("scan.stringified"), type: "number" } })).toBe(false);
      expect(holds({ field_type: { path: p("scan.count"), type: "boolean" } })).toBe(false);
    });

    it("reads through a JSON string and an array index", () => {
      expect(holds({ field_type: { path: p("blob.tags"), type: "array" } })).toBe(true);
      expect(holds({ field_type: { path: p("blob.inner"), type: "object" } })).toBe(true);
      expect(holds({ field_type: { path: p("list.0"), type: "object" } })).toBe(true);
    });
  });

  describe("not", () => {
    it("holds when the inner predicate does not", () => {
      expect(holds({ not: { of: { field_true: { path: p("scan.flag") } } } })).toBe(false);
      expect(holds({ not: { of: { field_true: { path: p("scan.label") } } } })).toBe(true);
      expect(holds({ not: { of: { empty: { path: p("scan.missing") } } } })).toBe(false);
      expect(holds({ not: { of: { gte: { path: p("scan.score"), n: 9 } } } })).toBe(true);
    });

    it("negates a comparison on an absent field: absent is not >= n, so not(gte) holds", () => {
      expect(holds({ not: { of: { gte: { path: p("scan.missing"), n: 0 } } } })).toBe(true);
    });
  });

  describe("totality", () => {
    it("the default throws on a name outside PREDICATE_NAMES", () => {
      expect(() =>
        evaluatePredicate({ bogus: { path: p("scan.label") } } as unknown as Predicate, CONTEXT),
      ).toThrow(/unknown predicate 'bogus'/);
    });

    it("throws on a shape that is not one name with a body", () => {
      for (const bad of [
        {},
        { field_true: { path: p("a") }, empty: { path: p("a") } },
        null,
        "x",
      ]) {
        expect(() => evaluatePredicate(bad as unknown as Predicate, CONTEXT)).toThrow();
      }
      expect(() =>
        evaluatePredicate({ field_true: "x" } as unknown as Predicate, CONTEXT),
      ).toThrow();
    });

    it("throws on a path that is not exactly one ${ref}", () => {
      for (const path of ["scan.flag", "x ${scan.flag}", "${scan.flag} ${scan.flag}", "${a+b}"]) {
        expect(() => evaluatePredicate({ field_true: { path } }, CONTEXT)).toThrow(/path/);
      }
    });

    it("throws on a not that wraps a not", () => {
      const nested = {
        not: { of: { not: { of: { field_true: { path: p("scan.flag") } } } } },
      } as unknown as Predicate;
      expect(() => evaluatePredicate(nested, CONTEXT)).toThrow(/not/);
    });

    it("every name in PREDICATE_NAMES evaluates to a boolean", () => {
      const samples: Readonly<Record<(typeof PREDICATE_NAMES)[number], Predicate>> = {
        field_equals: { field_equals: { path: p("scan.label"), value: "ok" } },
        field_true: { field_true: { path: p("scan.flag") } },
        in: { in: { path: p("scan.label"), values: ["ok"] } },
        gte: { gte: { path: p("scan.score"), n: 1 } },
        lt: { lt: { path: p("scan.score"), n: 1 } },
        count_gte: { count_gte: { path: p("scan.items"), n: 1 } },
        empty: { empty: { path: p("scan.blank") } },
        field_type: { field_type: { path: p("scan.label"), type: "string" } },
        not: { not: { of: { field_true: { path: p("scan.flag") } } } },
      };
      for (const name of PREDICATE_NAMES) {
        expect(typeof evaluatePredicate(samples[name], CONTEXT), name).toBe("boolean");
      }
    });
  });
});

describe("validatePredicate — the refusals of §4", () => {
  const issuesOf = (value: unknown) => validatePredicate(value, "n1", "when");

  /** Every refusal is a SpecIssue with a rule, the field it points at and an example to copy. */
  function refusal(value: unknown, field: string) {
    const issues = issuesOf(value);
    expect(issues.length, JSON.stringify(value)).toBeGreaterThan(0);
    const hit = issues.find((issue) => issue.field === field);
    expect(
      hit,
      `${JSON.stringify(value)} -> ${issues.map((i) => i.field).join(",")}`,
    ).toBeDefined();
    expect(hit?.rule).toMatch(/^[a-z_]+$/);
    expect(hit?.nodeId).toBe("n1");
    expect(hit?.message.length).toBeGreaterThan(0);
    expect(hit?.example).not.toBeNull();
    expect(hit?.example?.length).toBeGreaterThan(0);
    return hit;
  }

  describe("accepts", () => {
    const valid: readonly (readonly [string, unknown])[] = [
      ["field_equals string", { field_equals: { path: p("a.b"), value: "ok" } }],
      ["field_equals number", { field_equals: { path: p("a.b"), value: 0 } }],
      ["field_equals false", { field_equals: { path: p("a.b"), value: false } }],
      ["field_equals null", { field_equals: { path: p("a.b"), value: null } }],
      ["field_true", { field_true: { path: p("a") } }],
      ["in", { in: { path: p("a.b.0"), values: ["x", 1, true, null] } }],
      ["gte", { gte: { path: p("a"), n: 8.5 } }],
      ["gte negative", { gte: { path: p("a"), n: -3 } }],
      ["lt", { lt: { path: p("a"), n: 0 } }],
      ["count_gte", { count_gte: { path: p("a"), n: 0 } }],
      ["empty", { empty: { path: p("a") } }],
      ["field_type", { field_type: { path: p("a"), type: "array" } }],
      ["not", { not: { of: { empty: { path: p("a") } } } }],
    ];
    it.each(valid)("%s", (_name, predicate) => {
      expect(issuesOf(predicate)).toEqual([]);
    });

    it("accepts every PREDICATE_TYPES entry and 64 values", () => {
      for (const type of PREDICATE_TYPES) {
        expect(issuesOf({ field_type: { path: p("a"), type } })).toEqual([]);
      }
      const values = Array.from({ length: MAX_PREDICATE_VALUES }, (_, index) => index);
      expect(issuesOf({ in: { path: p("a"), values } })).toEqual([]);
    });
  });

  describe("refuses a shape that is not one name with a body", () => {
    it.each([
      ["a string", "field_true"],
      ["a number", 5],
      ["null", null],
      ["an array", [{ field_true: { path: p("a") } }]],
      ["an empty object", {}],
    ])("%s", (_name, value) => {
      refusal(value, "when");
    });

    it("two names at once", () => {
      refusal({ field_true: { path: p("a") }, empty: { path: p("a") } }, "when");
    });

    it("a body that is not an object", () => {
      refusal({ field_true: "${a}" }, "when.field_true");
      refusal({ field_true: null }, "when.field_true");
      refusal({ field_true: [p("a")] }, "when.field_true");
    });
  });

  describe("refuses an unknown name or a field the predicate does not have", () => {
    it("unknown name", () => {
      const hit = refusal({ bogus: { path: p("a") } }, "when.bogus");
      expect(hit?.rule).toBe("unknown_field");
      expect(hit?.example).toContain("field_equals");
    });

    it("and/or are not predicates: chain nodes instead", () => {
      refusal({ and: [{ field_true: { path: p("a") } }] }, "when.and");
      refusal({ or: [{ field_true: { path: p("a") } }] }, "when.or");
    });

    it("a field the predicate does not have", () => {
      const hit = refusal({ field_true: { path: p("a"), value: true } }, "when.field_true.value");
      expect(hit?.rule).toBe("unknown_field");
      refusal({ gte: { path: p("a"), n: 1, extra: 1 } }, "when.gte.extra");
      refusal({ not: { of: { empty: { path: p("a") } }, extra: 1 } }, "when.not.extra");
    });

    it("a required field that is missing", () => {
      expect(refusal({ field_true: {} }, "when.field_true.path")?.rule).toBe("missing_field");
      refusal({ field_equals: { path: p("a") } }, "when.field_equals.value");
      refusal({ in: { path: p("a") } }, "when.in.values");
      refusal({ gte: { path: p("a") } }, "when.gte.n");
      refusal({ lt: { path: p("a") } }, "when.lt.n");
      refusal({ count_gte: { path: p("a") } }, "when.count_gte.n");
      refusal({ field_type: { path: p("a") } }, "when.field_type.type");
      refusal({ not: {} }, "when.not.of");
    });
  });

  describe("refuses a path that is not exactly one ${ref}", () => {
    it.each([
      ["plain text", "scan.score"],
      ["a number", 5],
      ["null", null],
      ["an empty ref", "${}"],
      ["text around the ref", "score: ${scan.score}"],
      ["a ref and trailing text", "${scan.score}!"],
      ["two refs", "${a} ${b}"],
      ["an expression", "${a+b}"],
      ["a call", "${a(b)}"],
      ["a trailing dot", "${a.}"],
    ])("%s", (_name, path) => {
      const hit = refusal({ field_true: { path } }, "when.field_true.path");
      expect(hit?.rule).toBe("field_value");
      expect(hit?.example).toContain("${");
    });

    it("also inside a not", () => {
      refusal({ not: { of: { field_true: { path: "plain" } } } }, "when.not.of.field_true.path");
    });
  });

  describe("refuses a ${} inside an operand: operands are literals", () => {
    it("in value", () => {
      refusal({ field_equals: { path: p("a"), value: "${b}" } }, "when.field_equals.value");
      refusal({ field_equals: { path: p("a"), value: "x ${b.c} y" } }, "when.field_equals.value");
      refusal({ field_equals: { path: p("a"), value: "${}" } }, "when.field_equals.value");
    });

    it("in a values item", () => {
      refusal({ in: { path: p("a"), values: ["ok", "${b}"] } }, "when.in.values[1]");
    });
  });

  describe("refuses a value that is not a scalar", () => {
    it.each([
      ["an object", {}],
      ["an array", [1]],
      ["undefined", undefined],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("field_equals value %s", (_name, value) => {
      refusal({ field_equals: { path: p("a"), value } }, "when.field_equals.value");
    });

    it("a values item", () => {
      refusal({ in: { path: p("a"), values: ["ok", {}] } }, "when.in.values[1]");
      refusal({ in: { path: p("a"), values: [[1]] } }, "when.in.values[0]");
    });
  });

  describe("refuses values outside 1 to 64 scalars", () => {
    it("empty", () => {
      refusal({ in: { path: p("a"), values: [] } }, "when.in.values");
    });

    it("more than 64 items", () => {
      const values = Array.from({ length: MAX_PREDICATE_VALUES + 1 }, (_, index) => index);
      const issues = issuesOf({ in: { path: p("a"), values } });
      expect(issues.map((issue) => issue.field)).toEqual(["when.in.values"]);
      expect(issues[0]?.message).toContain("64");
    });

    it("not an array", () => {
      refusal({ in: { path: p("a"), values: "ok" } }, "when.in.values");
      refusal({ in: { path: p("a"), values: null } }, "when.in.values");
    });

    it("reports every bad item, not just the first", () => {
      const issues = issuesOf({ in: { path: p("a"), values: [{}, "ok", []] } });
      expect(issues.map((issue) => issue.field)).toEqual([
        "when.in.values[0]",
        "when.in.values[2]",
      ]);
    });
  });

  describe("refuses an n that is not allowed", () => {
    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["a numeric string", "3"],
      ["null", null],
    ])("gte and lt refuse %s", (_name, n) => {
      refusal({ gte: { path: p("a"), n } }, "when.gte.n");
      refusal({ lt: { path: p("a"), n } }, "when.lt.n");
    });

    it.each([
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a numeric string", "3"],
    ])("count_gte refuses %s: it needs an integer >= 0", (_name, n) => {
      refusal({ count_gte: { path: p("a"), n } }, "when.count_gte.n");
    });
  });

  describe("refuses a type outside the six", () => {
    it.each(["integer", "float", "Array", "undefined", "", "any"])("%j", (type) => {
      const hit = refusal({ field_type: { path: p("a"), type } }, "when.field_type.type");
      expect(hit?.example).toContain("array");
    });

    it("a type that is not a string", () => {
      refusal({ field_type: { path: p("a"), type: 5 } }, "when.field_type.type");
      refusal({ field_type: { path: p("a"), type: ["array"] } }, "when.field_type.type");
    });
  });

  describe("refuses a not inside a not", () => {
    it("at the inner not", () => {
      const nested = { not: { of: { not: { of: { field_true: { path: p("a") } } } } } };
      const hit = refusal(nested, "when.not.of.not");
      expect(hit?.message).toContain("not");
    });

    it("refuses an of that is itself invalid, pointing at where", () => {
      refusal({ not: { of: { bogus: {} } } }, "when.not.of.bogus");
      refusal({ not: { of: "x" } }, "when.not.of");
      refusal({ not: { of: { gte: { path: p("a"), n: Number.NaN } } } }, "when.not.of.gte.n");
    });
  });

  it("reports several problems of one predicate together", () => {
    const issues = issuesOf({ in: { path: "plain", values: [], extra: 1 } });
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      "when.in.extra",
      "when.in.path",
      "when.in.values",
    ]);
  });

  it("does not mutate the value it validates", () => {
    const value = Object.freeze({
      in: Object.freeze({ path: p("a"), values: Object.freeze(["x", "y"]) }),
    });
    expect(issuesOf(value)).toEqual([]);
  });

  it("uses the caller's node id and field prefix", () => {
    const issues = validatePredicate({ field_true: {} }, "check", "until");
    expect(issues[0]?.nodeId).toBe("check");
    expect(issues[0]?.field).toBe("until.field_true.path");
    expect(validatePredicate({ field_true: {} }, null, "when")[0]?.nodeId).toBeNull();
  });
});
