// Catálogo de mutantes de `src/auth/**` (issue #354): a lease de arquivo
// sobre a renovação do token, a separação da escrita do `try` do POST, e o
// erro nomeado que ela produz. Molde de `scripts/mutations/self-update-mutants.ts`
// (issue #148/#153) — mesma mecânica A (`scripts/mutations/harness.ts`), só o
// catálogo muda: cada mutante morre por um teste focado já existente ou novo
// em `tests/auth-core.test.ts`.
//
// Nenhum símbolo aqui depende de I/O; só dados.
import type { Mutant } from "./types.js";

const credentials = "src/auth/credentials.ts";
const lease = "src/auth/lease.ts";

const authFocus = "tests/auth-core.test.ts";

export const mutants: readonly Mutant[] = [
  {
    id: "T354-lease-ttl-zero",
    category: "lease-ttl",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "renews under a lease so two concurrent refreshes only hit oauthPost once (#354)",
    },
    edits: [
      {
        file: credentials,
        before: "const REFRESH_LEASE_TTL_SECONDS = 10;",
        after: "const REFRESH_LEASE_TTL_SECONDS = 0;",
      },
    ],
  },
  {
    id: "T354-expiring-soon-boundary",
    category: "expiring-soon-boundary",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "refreshes at the boundary and persists rotated tokens",
    },
    edits: [
      {
        file: credentials,
        before: "return now >= tokens.expiresAt - 300;",
        after: "return now >= tokens.expiresAt - 0;",
      },
    ],
  },
  {
    id: "T354-adopt-latest-disabled",
    category: "adopt-latest",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "adopts a token another process already wrote when this refresh attempt itself fails (#351 mitigation)",
    },
    edits: [
      {
        file: credentials,
        before: "if (latest !== null && latest.accessToken !== own.accessToken) return latest;",
        after: "if (latest !== null && latest.accessToken === own.accessToken) return latest;",
      },
    ],
  },
  {
    id: "T354-refresh-failed-generic",
    category: "refresh-failed-error-identity",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "throws RefreshFailedError when the refresh POST fails and nothing newer was saved (#354)",
    },
    edits: [
      {
        file: credentials,
        before:
          "if (latest !== null && latest.accessToken !== own.accessToken) return latest;\n    throw new RefreshFailedError(",
        after:
          "if (latest !== null && latest.accessToken !== own.accessToken) return latest;\n    throw new TokenPersistError(",
      },
    ],
  },
  {
    id: "T354-write-outside-try",
    category: "write-error-identity",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "names a write failure after a successful refresh differently from RefreshFailedError (#354)",
    },
    edits: [
      {
        file: credentials,
        before:
          "  try {\n    writeTokens(home, updated);\n  } catch (error) {\n    throw new TokenPersistError(",
        after:
          "  try {\n    writeTokens(home, updated);\n  } catch (error) {\n    throw new RefreshFailedError(",
      },
    ],
  },
  {
    id: "T354-lease-not-taken",
    category: "lease-not-taken",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "renews under a lease so two concurrent refreshes only hit oauthPost once (#354)",
    },
    edits: [
      {
        file: lease,
        before:
          '  if (existing !== null && existing.expiresAt > now) return false;\n  unlinkIfExists(path);\n  try {\n    createLeaseFile(path, { holder, expiresAt: now + ttlSeconds });\n    return true;\n  } catch (error) {\n    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;\n    throw error;\n  }\n}',
        after:
          '  if (existing !== null && existing.expiresAt > now) return true;\n  unlinkIfExists(path);\n  try {\n    createLeaseFile(path, { holder, expiresAt: now + ttlSeconds });\n    return true;\n  } catch (error) {\n    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;\n    throw error;\n  }\n}',
      },
    ],
  },
  {
    id: "T354-orphan-not-stolen",
    category: "orphan-lease-steal",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "blocks a second holder while held, and lets a new holder steal an orphaned (expired) one",
    },
    edits: [
      {
        file: lease,
        before: "  if (existing !== null && existing.expiresAt > now) return false;",
        after: "  if (existing !== null) return false;",
      },
    ],
  },
  {
    id: "T354-release-not-owned",
    category: "release-ownership",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "release is a no-op for a holder that no longer owns the lease",
    },
    edits: [
      {
        file: lease,
        before: "  if (existing === null || existing.holder !== holder) return;",
        after: "  if (existing === null) return;",
      },
    ],
  },
];
