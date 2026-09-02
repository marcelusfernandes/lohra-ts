/** Python's `str()`/`repr()` for JSON-shaped values — single-quoted strings,
 * `True`/`False`/`None`, `", "`/`": "` separators. Mirrors CPython's
 * `unicode_repr`: prefers single quotes, switches to double quotes only when
 * the string holds a `'` and no `"`.
 *
 * String fidelity matches CPython across ASCII controls/quotes/backslashes.
 * Like the approved T13 implementation, it intentionally does not attempt
 * Python's full Unicode `str.isprintable()` category table for C1 controls,
 * format characters or unassigned code points. */

function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let body = "";
  for (const character of value) {
    if (character === quote || character === "\\") body += `\\${character}`;
    else if (character === "\n") body += "\\n";
    else if (character === "\r") body += "\\r";
    else if (character === "\t") body += "\\t";
    else {
      const code = character.codePointAt(0) ?? 0;
      body += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : character;
    }
  }
  return `${quote}${body}${quote}`;
}

export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return reprString(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${pythonRepr(key)}: ${pythonRepr(entry)}`)
      .join(", ")}}`;
  if (typeof value === "symbol") return value.description ?? "";
  if (typeof value === "function") return value.name;
  return "None";
}
