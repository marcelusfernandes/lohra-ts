export type PythonNumberKind = "int" | "float";

const numberKinds = new WeakMap<object, ReadonlyMap<string, PythonNumberKind>>();

function rawNumberKinds(raw: string): ReadonlyMap<string, PythonNumberKind> {
  const kinds = new Map<string, PythonNumberKind>();
  const property = /"((?:\\.|[^"\\])*)"\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu;
  for (const match of raw.matchAll(property)) {
    const encodedKey = match[1];
    const token = match[2];
    if (encodedKey === undefined || token === undefined) continue;
    try {
      const key = JSON.parse(`"${encodedKey}"`) as string;
      kinds.set(key, token.includes(".") || /e/iu.test(token) ? "float" : "int");
    } catch {
      // The full JSON parse below is authoritative; an invalid key contributes no metadata.
    }
  }
  return kinds;
}

export function parseToolArguments(raw: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = parsed as Record<string, unknown>;
    numberKinds.set(result, rawNumberKinds(raw));
    return result;
  } catch {
    return {};
  }
}

export function pythonNumberKind(
  args: Readonly<Record<string, unknown>>,
  key: string,
): PythonNumberKind | null {
  return numberKinds.get(args)?.get(key) ?? null;
}
