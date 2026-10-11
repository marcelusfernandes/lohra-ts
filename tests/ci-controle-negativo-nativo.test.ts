import { describe, expect, it } from "vitest";

import { runNative } from "../scripts/ci/controle-negativo/native.js";

describe("controle negativo nativo opt-in", () => {
  it("recusa uma invocação sem base, HEAD, prova ou fontes antes de preparar artefatos", () => {
    expect(() => runNative(["--native"])).toThrow(/NATIVE_ARGUMENTS/);
  });
});
