function stripAnsi(value: string): string {
  return value
    .split(String.fromCodePoint(27))
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^\[[0-9;]*m/u, "")))
    .join("");
}

function normalizeT13Summary(line: string): string {
  if (!line.startsWith("{")) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof parsed !== "object" || parsed === null) return line;
  const summary = parsed as Record<string, unknown>;
  if (summary.suite !== "t13-orchestration-delegation" || !Array.isArray(summary.projections)) {
    return line;
  }
  return JSON.stringify({
    ...summary,
    projections: summary.projections.map((value: unknown) => {
      if (typeof value !== "object" || value === null) return value;
      const projection = { ...(value as Record<string, unknown>) };
      if (typeof projection.evidenceSha === "string") {
        projection.evidenceSha = "<volatile-artifact-sha>";
      }
      return projection;
    }),
  });
}

export function normalizeCloseoutOutput(value: string): string {
  return stripAnsi(value)
    .split("\n")
    .map((line) => {
      const structured = normalizeT13Summary(line);
      if (/^\s*Start at\b/iu.test(structured)) {
        return structured.replaceAll(/\b\d{2}:\d{2}:\d{2}\b/gu, "<clock>");
      }
      if (/^\s*(?:Duration\b|[✓×✗]\s)/iu.test(structured)) {
        return structured.replaceAll(/\b\d+(?:\.\d+)?m?s\b/gu, "<duration>");
      }
      return structured;
    })
    .join("\n")
    .trim();
}
