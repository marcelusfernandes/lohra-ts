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
      test: "renews under a lease so two concurrent refreshes only hit oauthPost once, issue 354",
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
      test: "adopts a token another process already wrote when this refresh attempt itself fails",
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
      test: "throws RefreshFailedError when the refresh POST fails and nothing newer was saved",
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
      test: "names a write failure after a successful refresh differently from RefreshFailedError, issue 354",
    },
    edits: [
      {
        file: credentials,
        before:
          "    throw new TokenPersistError(\n      `the login refresh succeeded but saving it to ${tokenPath(home)} failed",
        after:
          "    throw new RefreshFailedError(\n      `the login refresh succeeded but saving it to ${tokenPath(home)} failed",
      },
    ],
  },
  {
    id: "T354-lease-not-taken",
    category: "lease-not-taken",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "renews under a lease so two concurrent refreshes only hit oauthPost once, issue 354",
    },
    edits: [
      {
        file: lease,
        before: "  if (isLeaseAlive(path, ttlSeconds, now)) return false;",
        after: "  if (isLeaseAlive(path, ttlSeconds, now)) return true;",
      },
    ],
  },
  {
    id: "T354-orphan-not-stolen",
    category: "orphan-lease-steal",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "blocks a second holder while held, and lets a new holder steal an orphaned expired one",
    },
    edits: [
      {
        file: lease,
        before: "  if (existing !== null) return existing.expiresAt > now;",
        after: "  if (existing !== null) return true;",
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
  {
    id: "T356-illegible-lock-fail-open",
    category: "lease-fail-closed",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "um lock vazio recém-criado não é tomado antes do TTL, fail-closed",
    },
    edits: [
      {
        file: lease,
        before: "  return mtimeMs / 1000 + ttlSeconds > now;",
        after: "  return false;",
      },
    ],
  },
  {
    id: "T356-owner-skips-reread",
    category: "owner-reread-under-lease",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "dono relê sob a lease: token já renovado por outro não gera segundo POST",
    },
    edits: [
      {
        file: credentials,
        before: "if (underLease !== null && !isExpiringSoon(underLease, now)) return underLease;",
        after:
          "if (false && underLease !== null && !isExpiringSoon(underLease, now)) return underLease;",
      },
    ],
  },
  {
    id: "T356-loser-deadline-boundary",
    category: "loser-deadline-boundary",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "waitForFileLease respeita o deadline mesmo se a lease nunca aparecer livre, perdedor desiste",
    },
    edits: [
      {
        file: lease,
        before: "    if (Date.now() >= deadline) return;",
        after: "    if (Date.now() > deadline) return;",
      },
    ],
  },
  {
    id: "T356-lease-throw-identity",
    category: "lease-throw-error-identity",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "acquireFileLease lançando um erro que não é EEXIST vira TokenPersistError, não RefreshFailedError",
    },
    edits: [
      {
        file: credentials,
        before:
          "      throw new TokenPersistError(\n        `could not create the refresh lease at ${lockPath}",
        after:
          "      throw new RefreshFailedError(\n        `could not create the refresh lease at ${lockPath}",
      },
    ],
  },
  {
    id: "T356-waiter-disagrees-on-illegible",
    category: "waiter-fail-closed-agreement",
    mechanism: "family-a",
    focus: {
      file: authFocus,
      test: "com lock ilegível persistente, o perdedor espera o TTL do mtime em vez de voltar imediatamente",
    },
    edits: [
      {
        file: lease,
        before: "    if (!isLeaseAlive(path, options.ttlSeconds, now())) return;",
        after: "    if (false) return;",
      },
    ],
  },
];
