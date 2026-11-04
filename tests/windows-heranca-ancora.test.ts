// Issue #960 (épico #899, ADR 0006): prender no CI Linux o ramo que aceita a herança
// de um objeto que já existia. `Assert-Preexisting` (em `ACL_SCRIPT`) é o que decide,
// no Windows, se o home de um usuário existente serve; o CI obrigatório só roda os
// testes com operações injetadas e os de protocolo, e o `windows-checks` (informativo,
// elevado) pula aceite, identidades e Deny. Este arquivo lê o texto do script, sem
// executar nada, então roda em qualquer sistema operacional. Cada âncora é a forma e
// o lugar de uma conferência, no estilo de `windows-acl-batch.test.ts` (que prende as
// conferências estritas): trocar um operador, apagar um `throw` ou mover uma conferência
// para fora do laço reprova aqui. O mecanismo real continua em
// `windows-heranca-aprovada.test.ts`.
import { describe, expect, it } from "vitest";

import { ACL_SCRIPT } from "../src/security/windows-file-protection-native.js";

const FUNCTION = "function Assert-Preexisting($acl, [string]$me) {";
const OWNER = "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $me) {";
const GRANTS =
  "$grants = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))";
const EMPTY = "if ($grants.Count -eq 0) {";
const OTHERS = "$others = @()";
const SEEN = "$seen = @()";
const MINE = "$mine = $false";
const LOOP = "foreach ($grant in $grants) {";
const DENY = "if ($grant.AccessControlType -ne 'Allow') {";
const WHO = "$who = $grant.IdentityReference";
const USER = "if ($who.Value -eq $me) {";
const APPROVED =
  "} elseif ($who.Value -ne 'S-1-5-18' -and $who.Value -ne 'S-1-5-32-544' -and $seen -notcontains $who.Value) {";
const REFUSAL = "if ($others.Count -gt 0) {";
const FULL_CONTROL = "if (-not $mine) {";

// Call site, in the request loop.
const GUARD =
  "if ($request.preexisting -and ($fields[2] -ne 'preexisting' -or $request.action -ne 'verify')) {";
const FLAG = "preexisting = ($fields.Length -gt 2)";
const VOLUME = "if ($request.action -eq 'volume') {";
const PROTECT = "if ($request.action -eq 'protect') {";
const CALL_BLOCK = "if ($request.preexisting) {";
const CALL = "Assert-Preexisting $acl $identity.Value";

// Header lines of the blocks that enclose `index`, outermost first.
const enclosingBlocks = (index: number): string[] => {
  const blocks: string[] = [];
  for (let at = 0; at < index; at += 1) {
    if (ACL_SCRIPT[at] === "{") {
      blocks.push(ACL_SCRIPT.slice(ACL_SCRIPT.lastIndexOf("\n", at) + 1, at + 1).trim());
    } else if (ACL_SCRIPT[at] === "}") {
      blocks.pop();
    }
  }
  return blocks;
};

const matchingClose = (open: number): number => {
  let depth = 0;
  for (let at = open; at < ACL_SCRIPT.length; at += 1) {
    if (ACL_SCRIPT[at] === "{") depth += 1;
    else if (ACL_SCRIPT[at] === "}" && --depth === 0) return at;
  }
  return -1;
};

const onceAt = (needle: string): number => {
  const first = ACL_SCRIPT.indexOf(needle);
  expect(first, `script lacks: ${needle}`).toBeGreaterThanOrEqual(0);
  expect(ACL_SCRIPT.indexOf(needle, first + 1), `script repeats: ${needle}`).toBe(-1);
  return first;
};

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

// The block opened by the last `{` of `header`: where it sits, what encloses it, what it holds.
const locate = (header: string) => {
  const at = onceAt(header);
  const open = at + header.length - 1;
  expect(ACL_SCRIPT[open], `header does not end at a brace: ${header}`).toBe("{");
  const close = matchingClose(open);
  expect(close, `unbalanced block: ${header}`).toBeGreaterThan(open);
  return {
    at,
    open,
    close,
    parents: enclosingBlocks(open),
    body: squash(ACL_SCRIPT.slice(open + 1, close)),
  };
};

// Positions must grow in the order given, each at the nesting level `parents` names.
const expectInOrder = (statements: readonly string[], parents: readonly string[]) => {
  const positions = statements.map(onceAt);
  expect(positions, `out of order: ${statements.join(" | ")}`).toEqual(
    [...positions].sort((a, b) => a - b),
  );
  for (const statement of statements) {
    expect(enclosingBlocks(onceAt(statement)), `nesting of: ${statement}`).toEqual(parents);
  }
};

describe("windows ACL script: Assert-Preexisting refuses what the strict check would", () => {
  it("is one balanced top-level function, defined before the request loop calls it", () => {
    const check = locate(FUNCTION);
    expect(check.parents).toEqual([]);
    expect(enclosingBlocks(ACL_SCRIPT.length)).toEqual([]);
    expect(enclosingBlocks(check.open + 1)).toEqual([FUNCTION]);
    expect(check.at).toBeLessThan(onceAt(CALL));
    expect(check.close).toBeLessThan(onceAt(CALL));
  });

  it("states the owner, the DACL read, its tallies and the loop in this order, at the function's level", () => {
    const check = locate(FUNCTION);
    const statements = [OWNER, GRANTS, EMPTY, OTHERS, SEEN, MINE, LOOP, REFUSAL, FULL_CONTROL];
    expectInOrder(statements, [FUNCTION]);
    expect(onceAt(OWNER)).toBeGreaterThan(check.open);
    expect(onceAt(FULL_CONTROL)).toBeLessThan(check.close);
    // The first thing the function does is the owner check; nothing runs before it.
    expect(squash(ACL_SCRIPT.slice(check.open + 1, onceAt(OWNER)))).toBe("");
  });

  it("reads the explicit and the inherited rules, so an unapproved inherited identity is seen", () => {
    // GetAccessRules(includeExplicit, includeInherited, type): both must stay true.
    expect(locate(FUNCTION).body).toContain(GRANTS);
  });

  it.each([
    {
      check: "a different owner",
      header: OWNER,
      where: "before the loop",
      throws: "throw 'Windows file owner differs from the current identity'",
    },
    {
      check: "an empty DACL",
      header: EMPTY,
      where: "before the loop",
      throws: "throw 'Windows DACL is empty or unavailable'",
    },
    {
      check: "a rule that is not an Allow",
      header: DENY,
      where: "in the loop",
      throws: "throw 'Deny access rule cannot be verified'",
    },
    {
      check: "a user without full control",
      header: FULL_CONTROL,
      where: "after the loop",
      throws: "throw 'Windows owner lacks full control'",
    },
  ])("refuses $check, with nothing else in the branch ($where)", ({ header, where, throws }) => {
    const branch = locate(header);
    const loop = locate(LOOP);
    expect(branch.body).toBe(throws);
    if (where === "in the loop") {
      expect(branch.parents).toEqual([FUNCTION, LOOP]);
      expect(branch.at).toBeGreaterThan(loop.open);
      expect(branch.close).toBeLessThan(loop.close);
    } else {
      expect(branch.parents).toEqual([FUNCTION]);
      if (where === "before the loop") expect(branch.close).toBeLessThan(loop.at);
      else expect(branch.at).toBeGreaterThan(loop.close);
    }
  });

  it("looks at every rule for a Deny first: the loop starts with that check and then reads who it is for", () => {
    const loop = locate(LOOP);
    const deny = locate(DENY);
    expect(loop.parents).toEqual([FUNCTION]);
    expect(squash(ACL_SCRIPT.slice(loop.open + 1, deny.at))).toBe("");
    expect(squash(ACL_SCRIPT.slice(deny.close + 1, onceAt(WHO)))).toBe("");
    expectInOrder([DENY, WHO], [FUNCTION, LOOP]);
  });

  it("counts the user's own grant only when it applies to the object and has full control", () => {
    const user = locate(USER);
    expect(user.parents).toEqual([FUNCTION, LOOP]);
    expect(user.at).toBeGreaterThan(onceAt(WHO));
    expect(user.body).toBe(
      "if (($grant.PropagationFlags -band $inheritOnly) -eq 0 -and " +
        "($grant.FileSystemRights -band $fullControl) -eq $fullControl) { $mine = $true }",
    );
  });

  it("approves only the user, SYSTEM and Administrators: every other identity enters the refusal list", () => {
    const user = locate(USER);
    const approved = locate(APPROVED);
    const loop = locate(LOOP);
    expect(approved.parents).toEqual([FUNCTION, LOOP]);
    // The `}` that opens the header is the one that closes the user branch: same if/elseif,
    // so SYSTEM and Administrators are exempted only when the identity is not the user's.
    expect(approved.at).toBe(user.close);
    expect(approved.body).toBe(
      "$seen += $who.Value " +
        "try { $others += " +
        '"$($who.Translate([System.Security.Principal.NTAccount]).Value) ($($who.Value))" ' +
        "} catch { $others += $who.Value }",
    );
    // No `else` that accepts what the chain did not name, and no statement after it.
    expect(squash(ACL_SCRIPT.slice(approved.close + 1, loop.close))).toBe("");
  });

  it("throws with the list of unapproved identities and the way out when it is not empty", () => {
    const refusal = locate(REFUSAL);
    const loop = locate(LOOP);
    expect(refusal.parents).toEqual([FUNCTION]);
    expect(refusal.at).toBeGreaterThan(loop.close);
    // One throw, and nothing else in the branch.
    expect(refusal.body).toMatch(
      /^throw "Windows DACL grants access to unapproved identities: \$\(\$others -join ', '\)\. [^"]+"$/,
    );
    expect(refusal.body).toContain("Move or rename this path so Lohra recreates it protected");
    expect(refusal.body).toContain("point LOHRA_HOME at a new path");
  });
});

describe("windows ACL script: Assert-Preexisting is called only for a preexisting verify", () => {
  it("names the check twice in the whole script: its definition and one call", () => {
    expect(ACL_SCRIPT.match(/Assert-Preexisting/g)).toHaveLength(2);
    onceAt(CALL);
  });

  it("derives the flag from the option field, and accepts it only on a verify line", () => {
    const guard = locate(GUARD);
    const volume = locate(VOLUME);
    expect(guard.body).toBe("throw 'Unknown ACL option'");
    expect(guard.parents).toEqual(volume.parents);
    // The flag is read before the guard, and the option is validated before any action runs.
    expect(onceAt(FLAG)).toBeLessThan(guard.at);
    expect(guard.close).toBeLessThan(volume.at);
  });

  it("calls it on the ACL read, behind the flag alone, and skips the strict checks", () => {
    const call = locate(CALL_BLOCK);
    const protect = locate(PROTECT);
    // Same level as the protect branch: both live in the `else` of the volume action.
    expect(call.parents).toEqual(protect.parents);
    expect(call.parents.at(-1)).toBe("} else {");
    expect(call.body).toBe("Assert-Preexisting $acl $identity.Value $done++ continue");
    // The first read of the ACL is the one before the flag branch, never the re-read of protect.
    const read = ACL_SCRIPT.indexOf("$acl = Read-Acl $path");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(call.at);
    expect(call.close).toBeLessThan(protect.at);
    // The one call sits in that branch (the guard above refused the flag on any other action).
    expect(onceAt(CALL)).toBeGreaterThan(call.open);
    expect(onceAt(CALL)).toBeLessThan(call.close);
  });
});
