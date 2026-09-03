function stripAnsi(value: string): string {
  return value
    .split(String.fromCodePoint(27))
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^\[[0-9;]*m/u, "")))
    .join("");
}

export function normalizeCloseoutOutput(value: string): string {
  return stripAnsi(value)
    .split("\n")
    .map((line) => {
      if (/^\s*(?:Duration|Start at)\b/iu.test(line)) {
        return line.replaceAll(/\d+(?:\.\d+)?(?:ms|s)/gu, "<duration>");
      }
      if (/^\s*[✓×✗]\s/u.test(line)) {
        return line.replaceAll(/\(\d+(?:\.\d+)?\s*m?s\)/gu, "(<duration>)");
      }
      return line;
    })
    .join("\n")
    .trim();
}
