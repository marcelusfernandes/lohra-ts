import { describe, expect, it } from "vitest";

import { branchSlug, resolveProvaSlug } from "../scripts/prova/slug.js";

describe("branchSlug", () => {
  it("extracts the slug from a <type>/<n>-<slug> branch", () => {
    expect(branchSlug("feat/12-workflow-store")).toBe("workflow-store");
    expect(branchSlug("fix/3-stub-driver-port")).toBe("stub-driver-port");
  });

  it("returns null for main and other names that don't follow the convention", () => {
    expect(branchSlug("main")).toBeNull();
    expect(branchSlug("traycer/t22-self-update-closeout")).toBeNull();
    expect(branchSlug("feat/no-number")).toBeNull();
  });
});

describe("resolveProvaSlug", () => {
  it("returns null for main", () => {
    expect(resolveProvaSlug("main", () => true)).toBeNull();
  });

  it("returns null when prova/<slug>.ts does not exist", () => {
    const exists = (path: string): boolean => path === "prova/other.ts";
    expect(resolveProvaSlug("feat/12-x", exists)).toBeNull();
  });

  it("returns the slug when prova/<slug>.ts exists", () => {
    const exists = (path: string): boolean => path === "prova/x.ts";
    expect(resolveProvaSlug("feat/12-x", exists)).toBe("x");
  });
});
