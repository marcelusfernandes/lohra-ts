/** Fidelity primitives for JSON numbers read/written by providers and stores
 * — a concern the ADR keeps even after `python-json.ts` stops mimicking
 * `json.dumps` (docs/adr/0003-native-wire-format.md, "Number fidelity is a
 * separate concern and is kept"). Nothing here targets Python bytes: it
 * exists so a float that arrived as `1.0` doesn't silently become the
 * integer `1`, and an integer beyond `Number.MAX_SAFE_INTEGER` doesn't
 * silently lose precision, anywhere this runtime parses or emits JSON.
 *
 * TODO(#70): stub bodies below throw; the real bodies land with the next
 * commit on this branch. */

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

export function parseJsonPreservingNumbers(_value: string): unknown {
  throw new Error("not implemented: parseJsonPreservingNumbers");
}

export function stringifyJsonPreservingNumbers(_value: unknown): string {
  throw new Error("not implemented: stringifyJsonPreservingNumbers");
}
