export function componentTargetMatches(
  value: Readonly<Record<string, unknown>>,
  targetSha: string,
): boolean {
  return value.targetSha === targetSha;
}

export function architectureRulingMatches(gateDecision: string, ruling: string): boolean {
  return (
    gateDecision.includes("typescript-mainline") &&
    ruling.includes("typescript-mainline") &&
    ruling.includes("docs/gate-decision-t22.md") &&
    ruling.includes("marcelusfernandes") &&
    ruling.includes("2026-09-03")
  );
}

export function gatesEvidenceMatches(
  gates: Readonly<Record<string, unknown>>,
  targetSha: string,
): boolean {
  return (
    gates.targetSha === targetSha &&
    gates.typecheck === true &&
    gates.lint === true &&
    gates.build === true &&
    typeof gates.testFiles === "number" &&
    gates.testFiles >= 150 &&
    typeof gates.tests === "number" &&
    gates.tests >= 1475 &&
    gates.format === true &&
    gates.pack === true &&
    gates.diffCheck === true
  );
}

export function concurrencyEvidenceMatches(
  value: Readonly<Record<string, unknown>>,
  targetSha: string,
): boolean {
  return (
    value.targetSha === targetSha &&
    value.realParityGates === 2 &&
    value.overlapped === true &&
    value.bothPassed === true &&
    value.dynamicStubPort === true &&
    value.fixedPortUsed === false &&
    value.resourcesReleased === true
  );
}
