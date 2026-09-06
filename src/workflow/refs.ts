import { stringifyJsonPreservingNumbers } from "../serialization/json-numbers.js";
import { loadsLenient, UNPARSEABLE } from "./jsonio.js";

const REF_PATTERN = /\$\{([^}]*)\}/gu;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DECIMAL = /^\p{Nd}+$/u;

const DECIMAL_ZEROES = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
  0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50,
  0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0,
  0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730,
  0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1e140, 0x1e2f0,
  0x1e4f0, 0x1e950,
];

export class InvalidReferenceError extends Error {
  readonly code = "REF_INVALID";
  readonly reference: string;

  constructor(reference: string) {
    super(`invalid reference syntax: ${reference}`);
    this.name = "InvalidReferenceError";
    this.reference = reference;
  }
}

export function findRefs(value: unknown): string[] {
  const refs: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(REF_PATTERN)) refs.push(match[1] ?? "");
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return refs;
}

export function isValidRef(reference: string): boolean {
  if (reference === "") return false;
  return reference.split(".").every((part) => IDENTIFIER.test(part) || DECIMAL.test(part));
}

export function invalidRefs(value: unknown): string[] {
  return findRefs(value).filter((reference) => !isValidRef(reference));
}

function decimalIndex(value: string): number {
  let result = 0;
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point === undefined) throw new InvalidReferenceError(value);
    const zero = DECIMAL_ZEROES.find((candidate) => point >= candidate && point <= candidate + 9);
    if (zero === undefined) throw new InvalidReferenceError(value);
    result = result * 10 + point - zero;
  }
  return result;
}

function lookup(reference: string, context: unknown): unknown {
  let current: unknown = context;
  for (const part of reference.split(".")) {
    if (typeof current === "string") {
      const parsed = loadsLenient(current);
      if (parsed !== UNPARSEABLE) current = parsed;
    }
    if (Array.isArray(current) && DECIMAL.test(part)) {
      current = current[decimalIndex(part)];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
    if (current === undefined) return null;
  }
  return current;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return stringifyJsonPreservingNumbers(value);
}

function assertValid(value: unknown): void {
  const invalid = invalidRefs(value);
  if (invalid[0] !== undefined) throw new InvalidReferenceError(invalid[0]);
}

export function resolveValue(value: unknown, context: unknown): unknown {
  assertValid(value);
  if (typeof value === "string") {
    const whole = /^\s*\$\{([^}]*)\}\s*$/u.exec(value);
    if (whole?.[1] !== undefined) return lookup(whole[1], context);
    return value.replace(REF_PATTERN, (_match, reference: string) =>
      stringify(lookup(reference, context)),
    );
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, context)]),
    );
  }
  return value;
}

export function resolveStrict(value: unknown, context: unknown): readonly [unknown, string | null] {
  assertValid(value);
  for (const reference of findRefs(value)) {
    if (lookup(reference, context) === null) return [null, reference];
  }
  return [resolveValue(value, context), null];
}
