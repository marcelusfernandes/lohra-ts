/** Fidelity primitives for JSON numbers read/written by providers and stores
 * — a concern the ADR keeps even after `python-json.ts` stops mimicking
 * `json.dumps` (docs/adr/0003-native-wire-format.md, "Number fidelity is a
 * separate concern and is kept"). Nothing here targets Python bytes: it
 * exists so a float that arrived as `1.0` doesn't silently become the
 * integer `1`, and an integer beyond `Number.MAX_SAFE_INTEGER` doesn't
 * silently lose precision, anywhere this runtime parses or emits JSON. */

export class JsonFloat {
  public constructor(public readonly value: number) {}
}

export function jsonFloat(value: number): JsonFloat {
  return new JsonFloat(value);
}

export class JsonInteger {
  public constructor(public readonly value: bigint) {}
}

export function jsonInteger(value: bigint): JsonInteger {
  return new JsonInteger(value);
}

class JsonNumberParser {
  private index = 0;

  public constructor(private readonly source: string) {}

  public parse(): unknown {
    const value = this.value();
    this.whitespace();
    if (this.index !== this.source.length) throw new SyntaxError("Unexpected JSON suffix");
    return value;
  }

  private whitespace(): void {
    while (/\s/u.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private value(): unknown {
    this.whitespace();
    const token = this.source[this.index];
    if (token === '"') return this.string();
    if (token === "{") return this.object();
    if (token === "[") return this.array();
    if (token === "t") return this.literal("true", true);
    if (token === "f") return this.literal("false", false);
    if (token === "n") return this.literal("null", null);
    // A JSON extension this runtime accepts by default on read, matching the
    // permissiveness `json.loads` had in the Python predecessor: a value
    // this runtime's own writer round-trips must not spuriously fail here.
    if (token === "N") return this.literal("NaN", jsonFloat(NaN));
    if (token === "I") return this.literal("Infinity", jsonFloat(Number.POSITIVE_INFINITY));
    if (token === "-" && this.source.startsWith("-Infinity", this.index)) {
      return this.literal("-Infinity", jsonFloat(Number.NEGATIVE_INFINITY));
    }
    return this.number();
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (token === "\\") {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (token === '"') return JSON.parse(this.source.slice(start, this.index)) as string;
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  private object(): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = {};
    this.whitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.whitespace();
      if (this.source[this.index] !== '"') throw new SyntaxError("Expected JSON object key");
      const key = this.string();
      this.whitespace();
      if (this.source[this.index] !== ":") throw new SyntaxError("Expected JSON colon");
      this.index += 1;
      Object.defineProperty(result, key, {
        value: this.value(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.whitespace();
      const delimiter = this.source[this.index];
      this.index += 1;
      if (delimiter === "}") return result;
      if (delimiter !== ",") throw new SyntaxError("Expected JSON object delimiter");
    }
  }

  private array(): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.whitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.value());
      this.whitespace();
      const delimiter = this.source[this.index];
      this.index += 1;
      if (delimiter === "]") return result;
      if (delimiter !== ",") throw new SyntaxError("Expected JSON array delimiter");
    }
  }

  private literal(text: string, value: unknown): unknown {
    if (!this.source.startsWith(text, this.index)) throw new SyntaxError("Invalid JSON literal");
    this.index += text.length;
    return value;
  }

  private number(): number | JsonFloat | JsonInteger {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!match) throw new SyntaxError("Invalid JSON number");
    this.index += match.length;
    if (match.includes(".") || /e/iu.test(match)) return jsonFloat(Number(match));
    const integer = BigInt(match);
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(integer)
      : jsonInteger(integer);
  }
}

/** Parses JSON, keeping int/float identity (a bare `1.0` stays a float) and
 * arbitrary-precision integers beyond `Number.MAX_SAFE_INTEGER` intact.
 * Accepts the `NaN`/`Infinity`/`-Infinity` literal extension on read. */
export function parseJsonPreservingNumbers(value: string): unknown {
  return new JsonNumberParser(value).parse();
}

function decimalParts(value: number): { readonly digits: string; readonly exponent: number } {
  const raw = Math.abs(value).toString().toLowerCase();
  const exponentIndex = raw.indexOf("e");
  if (exponentIndex >= 0) {
    const mantissa = raw.slice(0, exponentIndex);
    const exponent = Number(raw.slice(exponentIndex + 1));
    return { digits: mantissa.replace(".", "").replace(/0+$/, ""), exponent };
  }
  const decimalIndex = raw.indexOf(".");
  if (decimalIndex < 0) {
    return { digits: raw.replace(/0+$/, ""), exponent: raw.length - 1 };
  }
  const integer = raw.slice(0, decimalIndex);
  const fraction = raw.slice(decimalIndex + 1);
  if (integer !== "0") {
    return {
      digits: `${integer}${fraction}`.replace(/0+$/, ""),
      exponent: integer.length - 1,
    };
  }
  const first = fraction.search(/[1-9]/);
  return { digits: fraction.slice(first).replace(/0+$/, ""), exponent: -(first + 1) };
}

function exponentText(exponent: number): string {
  const sign = exponent < 0 ? "-" : "+";
  return `${sign}${Math.abs(exponent).toString().padStart(2, "0")}`;
}

function encodeFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  if (value === 0) return "0.0";

  const { digits, exponent } = decimalParts(value);
  const sign = value < 0 ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.slice(1);
    const mantissa = fraction.length === 0 ? digits.charAt(0) : `${digits.charAt(0)}.${fraction}`;
    return `${sign}${mantissa}e${exponentText(exponent)}`;
  }
  if (exponent < 0) {
    return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  }
  const integerLength = exponent + 1;
  if (digits.length <= integerLength) {
    return `${sign}${digits}${"0".repeat(integerLength - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, integerLength)}.${digits.slice(integerLength)}`;
}

function encodeCompact(value: unknown): string {
  if (value instanceof JsonInteger) return value.value.toString();
  if (value instanceof JsonFloat) return encodeFloat(value.value);
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => (entry === undefined ? "null" : encodeCompact(entry))).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}:${encodeCompact(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Value of type ${typeof value} is not JSON serializable`);
}

/** Compact JSON stringify that respects `JsonFloat`/`JsonInteger` markers —
 * a float keeps its trailing `.0`, an out-of-range integer keeps every
 * digit. Plain `number`s serialize with the JS engine's own rules.
 *
 * TODO(#71, test-red): `indent` is not implemented yet, and non-finite
 * numbers are not yet rejected — the next commit makes this throw
 * (docs/adr/0003-native-wire-format.md, "JSON output" item 4) and adds the
 * two-space indent shape (item 3). */
export function stringifyJsonPreservingNumbers(value: unknown, indent?: 2): string {
  void indent;
  return encodeCompact(value);
}
