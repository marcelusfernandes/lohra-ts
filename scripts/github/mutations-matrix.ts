// Stub vermelho (#156): a seleção de fatias ainda não existe.
export interface SliceEntry {
  readonly slice: string;
  readonly script: string;
  readonly srcGlobs: readonly string[];
}

export interface MatrixEntry {
  readonly slice: string;
  readonly script: string;
}

export interface Matrix {
  readonly count: number;
  readonly include: readonly MatrixEntry[];
  readonly reason: "harness" | "paths";
}

export function readSlices(_path: string): readonly SliceEntry[] {
  throw new Error("TODO(#156): mutations-matrix ainda não implementado");
}

export function selectSlices(_slices: readonly SliceEntry[], _files: readonly string[]): Matrix {
  throw new Error("TODO(#156): mutations-matrix ainda não implementado");
}
