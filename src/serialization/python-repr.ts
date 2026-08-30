/**
 * Reproduces Python's repr() for str: single quotes by default, switching to
 * double quotes only when the string contains a single quote and no double
 * quote; backslash and the chosen quote are escaped; \n, \r, \t get their
 * two-character escapes; other C0 controls (and DEL) get \xHH; everything
 * else — including non-ASCII printable characters — is left literal.
 *
 * This is NOT verbatim interpolation: the oracle's `%r` formatting of an env
 * var's raw value uses this rule, not the raw bytes, and a naive `'${raw}'`
 * template diverges for any raw value containing a quote, backslash, or
 * control character.
 */
export function pythonRepr(value: string): string {
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let result = quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    const code = value.charCodeAt(index);
    if (character === "\\") result += "\\\\";
    else if (character === quote) result += `\\${quote}`;
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (code < 0x20 || code === 0x7f)
      result += `\\x${code.toString(16).padStart(2, "0")}`;
    else result += character;
  }
  return `${result}${quote}`;
}
