export interface NativeRoute {
  readonly proof: string;
  readonly units: readonly string[];
  readonly sources: readonly string[];
}

export type NativeRoutes = Readonly<Record<string, NativeRoute>>;

/** Valida uma única árvore Git, sem executar suas provas. */
export function validateNativeRoutes(_root: string, _sha: string): NativeRoutes {
  throw new Error("not implemented: validateNativeRoutes");
}
