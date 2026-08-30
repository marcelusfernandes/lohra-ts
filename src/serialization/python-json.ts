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
  if (value instanceof PythonFloat) return encodeFloat(value.value);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return escapeString(value, ensureAscii);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
    throw new TypeError(
      "Ambiguous or unsafe number: wrap Python float fields with pythonFloat(value)",
    );
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
  if (typeof value === "object" && value !== null && !(value instanceof PythonFloat)) {
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
