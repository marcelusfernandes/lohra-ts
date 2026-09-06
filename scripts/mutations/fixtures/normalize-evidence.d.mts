export interface EvidenceNormalization {
  readonly field: string;
  readonly kind: "replace-regex" | "structural-replace-regex";
  readonly pattern: string;
  readonly replacement: string;
  readonly scope?: string;
  readonly why: string;
}
export declare const EVIDENCE_NORMALIZATIONS: readonly EvidenceNormalization[];
export declare function normalizeEvidence(text: string): string;
