function escapeString(value: string, ensureAscii = true): string {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = value[index] as string;
    if (character === '"') result += '\\"';
    else if (character === "\\") result += "\\\\";
    else if (character === "\b") result += "\\b";
    else if (character === "\f") result += "\\f";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (code < 0x20 || (ensureAscii && code > 0x7e))
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += character;
  }
  return `${result}"`;
}

export class PythonFloat {
  public constructor(public readonly value: number) {}
}

export function pythonFloat(value: number): PythonFloat {
  return new PythonFloat(value);
}

class PythonInteger {
  public constructor(public readonly value: bigint) {}
}

class PythonJsonParser {
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

  private number(): number | PythonFloat | PythonInteger {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!match) throw new SyntaxError("Invalid JSON number");
    this.index += match.length;
    if (match.includes(".") || /e/iu.test(match)) return pythonFloat(Number(match));
    const integer = BigInt(match);
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(integer)
      : new PythonInteger(integer);
  }
}

export function pythonJsonLoads(value: string): unknown {
  return new PythonJsonParser(value).parse();
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

function compareUnicode(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function encode(value: unknown, sortKeys: boolean, ensureAscii = true): string {
  if (value instanceof PythonInteger) return value.value.toString();
  if (value instanceof PythonFloat) return encodeFloat(value.value);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return escapeString(value, ensureAscii);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
    throw new TypeError("Ambiguous or unsafe number in Python-compatible JSON serialization");
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => encode(entry, sortKeys, ensureAscii)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    );
    if (sortKeys) entries.sort(([left], [right]) => compareUnicode(left, right));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${escapeString(key, ensureAscii)}: ${encode(entry, sortKeys, ensureAscii)}`,
      )
      .join(", ")}}`;
  }
  throw new TypeError(`Value of type ${typeof value} is not JSON serializable`);
}

function encodeCompact(value: unknown): string {
  if (value instanceof PythonInteger) return value.value.toString();
  if (value instanceof PythonFloat) return encodeFloat(value.value);
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

export function jsonStringifyPythonNumbers(value: unknown): string {
  return encodeCompact(value);
}

export function pythonJsonDumps(value: unknown): string {
  return encode(value, true);
}

export function pythonJsonDumpsInsertionOrder(value: unknown): string {
  return encode(value, false);
}

export function pythonJsonDumpsInsertionOrderUnicode(value: unknown): string {
  return encode(value, false, false);
}

function encodeIndented(value: unknown, level: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = " ".repeat((level + 1) * 2);
    const end = " ".repeat(level * 2);
    return `[\n${value.map((entry) => `${pad}${encodeIndented(entry, level + 1)}`).join(",\n")}\n${end}]`;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof PythonFloat) &&
    !(value instanceof PythonInteger)
  ) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    );
    if (entries.length === 0) return "{}";
    const pad = " ".repeat((level + 1) * 2);
    const end = " ".repeat(level * 2);
    return `{\n${entries
      .map(([key, entry]) => `${pad}${escapeString(key)}: ${encodeIndented(entry, level + 1)}`)
      .join(",\n")}\n${end}}`;
  }
  return encode(value, false);
}

export function pythonJsonDumpsIndented(value: unknown): string {
  return encodeIndented(value, 0);
}
