// Issue #149 (passo 0b do épico #13): a parte "nomeada" (a-z, aa-am, p, q, o)
// do catálogo de mutantes de `mutations:t16`, migrada do runner legado de
// paridade sem mudar id/mechanism/edits — só o caminho e o tipo importado
// mudam. Separado de `workflow-durability.ts` só para caber no limite de
// 800 linhas por arquivo (`arquivo-grande`): 38 mutantes, cada um escorado
// num único foco (`{file, test}`) em vez da bateria inteira.
//
// Each focus is run GREEN at baseline before it is run under its mutant, so a
// filter that matches no test can never be mistaken for a kill.
import type { Mutant } from "./types.js";

const locks = "src/state/locks.ts";
const repository = "src/state/workflow-repository.ts";
const durability = "src/workflow/durability.ts";
const service = "src/workflow/service.ts";
const sandbox = "src/workflow/sandbox.ts";
const sqliteCache = "src/workflow/sqlite-cache.ts";
const engine = "src/workflow/engine.ts";
const normalizer = "scripts/mutations/fixtures/normalize-evidence.mjs";

const repositoryTests = "tests/state-workflow-repository.test.ts";
const serviceTests = "tests/workflow-service-durability.test.ts";
const durabilityTests = "tests/workflow-durability.test.ts";
const sandboxTests = "tests/workflow-sandbox.test.ts";

export const namedMutants: readonly Mutant[] = [
  {
    id: "a/acquire-advances-fence-on-loser",
    category: "fence",
    mechanism: "the fence bump leaks outside the winning transaction, so a loser advances it",
    focus: { file: repositoryTests, test: "keeps the fence row alive across releases" },
    edits: [
      {
        file: locks,
        before:
          '          this.database\n            .prepare(\n              "UPDATE workflow_run_fence SET fence = fence + 1, updated_at = ? WHERE run_id = ?",\n            )\n            .run(now, runId);\n          const row = this.database\n            .prepare("SELECT fence FROM workflow_run_fence WHERE run_id = ?")\n            .get(runId) as { readonly fence: bigint };',
        after:
          '          const row = this.database\n            .prepare("SELECT fence FROM workflow_run_fence WHERE run_id = ?")\n            .get(runId) as { readonly fence: bigint };\n          this.database\n            .prepare(\n              "UPDATE workflow_run_fence SET fence = fence + 1, updated_at = ?",\n            )\n            .run(now);',
      },
    ],
  },
  {
    id: "b/release-deletes-fence-row",
    category: "fence",
    mechanism: "release deletes the fence row, so the fence no longer survives a release",
    focus: { file: repositoryTests, test: "keeps the fence row alive across releases" },
    edits: [
      {
        file: locks,
        before:
          '      const result = this.database\n        .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND holder = ?")\n        .run(runId, holder);\n      return result.changes > 0;',
        after:
          '      const result = this.database\n        .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND holder = ?")\n        .run(runId, holder);\n      this.database.prepare("DELETE FROM workflow_run_fence WHERE run_id = ?").run(runId);\n      return result.changes > 0;',
      },
    ],
  },
  {
    id: "c/heartbeat-renews-after-release",
    category: "heartbeat",
    mechanism: "the heartbeat keeps beating after the lease is gone (immortal timer)",
    focus: { file: durabilityTests, test: "stops at ownership loss" },
    edits: [
      {
        file: durability,
        before: "    if (!held) return; // the lease is somebody else's now; beating on is noise",
        after: "    if (!held) { this.arm(runId); return; }",
      },
    ],
  },
  {
    id: "d/renew-resurrects-expired-lease",
    category: "lease",
    mechanism: "renew drops its validity predicate, so an old holder resurrects an expired lease",
    focus: { file: repositoryTests, test: "renews only the live holder" },
    edits: [
      {
        file: locks,
        before: "           WHERE run_id = ? AND holder = ? AND expires_at > ?",
        after: "           WHERE run_id = ? AND holder = ? AND ? IS NOT NULL",
      },
    ],
  },
  {
    id: "e/autoresume-armed-for-token-budget",
    category: "auto-resume",
    mechanism: "cold start re-arms token_budget_exhausted pauses, which waiting never refills",
    focus: { file: durabilityTests, test: "rearmPendingResumes re-arms only quota-paused" },
    edits: [
      {
        file: durability,
        before: '    for (const row of pausedOn("quota_exhausted")) {',
        after:
          '    for (const row of [...pausedOn("quota_exhausted"), ...pausedOn("token_budget_exhausted")]) {',
      },
    ],
  },
  {
    id: "f/resume-reexecutes-complete-cell",
    category: "resume",
    mechanism:
      "the fenced cache reports a miss for cells that already completed, so a resume redoes paid work",
    focus: { file: serviceTests, test: "durable launch defaults to the fenced SQLite node cache" },
    edits: [
      {
        file: sqliteCache,
        before:
          "if (cell === undefined) return Object.freeze({ hit: false, output: null, cost: null });",
        after:
          'if (cell === undefined || cell.status === "complete") return Object.freeze({ hit: false, output: null, cost: null });',
      },
    ],
  },
  {
    id: "g/spend-seeded-before-acquire",
    category: "launch",
    mechanism: "the budget seed reads the ledger before ownership is proven",
    focus: { file: serviceTests, test: "seeds spend only AFTER acquiring the lease" },
    edits: [
      {
        file: service,
        before: `    const fence = store.locks.acquireRunLease(
      runId,
      store.holder,
      store.ownershipOf().now,
      store.ttl,
    );
    if (fence === null) {
      const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);
      return Object.freeze({
        error: busyErrorMessage(runId, expiry, store.ownershipOf().now),
      });
    }
    this.heartbeat?.start(runId);
    const seeded = this.seedSpend(store, runId);`,
        after: `    const seeded = this.seedSpend(store, runId);
    const fence = store.locks.acquireRunLease(
      runId,
      store.holder,
      store.ownershipOf().now,
      store.ttl,
    );
    if (fence === null) {
      const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);
      return Object.freeze({
        error: busyErrorMessage(runId, expiry, store.ownershipOf().now),
      });
    }
    this.heartbeat?.start(runId);`,
      },
    ],
  },
  {
    id: "h/sandbox-realpath-removed",
    category: "sandbox",
    mechanism: "fs containment compares raw paths, so a symlink escapes the working root",
    focus: { file: sandboxTests, test: "resolves symlinks via realpath" },
    edits: [
      {
        file: sandbox,
        before: "    const real = existsSync(current) ? realpathSync(current) : null;",
        after: "    const real = existsSync(current) ? current : null;",
      },
    ],
  },
  {
    id: "i1/absent-policy-opens-everything",
    category: "sandbox",
    mechanism: "a missing operator policy file grants everything instead of denying by default",
    focus: { file: sandboxTests, test: "default-deny when the operator file is absent" },
    edits: [
      {
        file: sandbox,
        before: "    if (!existsSync(path)) return { fsAllow: [], egressAllow: [] };",
        after:
          '    if (!existsSync(path)) return { fsAllow: [{ path: "/", writable: true }], egressAllow: ["*"] };',
      },
    ],
  },
  {
    id: "i2/spec-widens-policy",
    category: "sandbox",
    mechanism:
      "the launched run merges fs_allow/egress_allow out of the SPEC into the operator policy",
    focus: { file: serviceTests, test: "carries the OPERATOR policy, not the spec" },
    edits: [
      {
        file: service,
        before:
          "    const policy = this.policyLoader?.() ?? DENY_ALL_POLICY;\n    const workingRoot = this.workingRootOf(runId, fence);",
        after: `    const operator = this.policyLoader?.() ?? DENY_ALL_POLICY;
    const declared = parsed.meta as unknown as Record<string, unknown>;
    const policy: SandboxPolicy = {
      fsAllow: [
        ...operator.fsAllow,
        ...(Array.isArray(declared.fs_allow) ? declared.fs_allow : []).map((entry) => ({
          path: String(entry),
          writable: true,
        })),
      ],
      egressAllow: [
        ...operator.egressAllow,
        ...(Array.isArray(declared.egress_allow) ? declared.egress_allow : []).map(String),
      ],
    };
    const workingRoot = this.workingRootOf(runId, fence);`,
      },
    ],
  },
  {
    id: "j/cancel-read-then-write",
    category: "cancel",
    mechanism:
      "cancel decides busy from a separate read, reopening the window an owner can acquire in",
    focus: { file: serviceTests, test: "cancel busy is decided by the write's own statement" },
    edits: [
      {
        file: service,
        before:
          "    // The BUSY decision rides in the write's own statement (requireUnleased):\n    // no read-before-write window in which an owner could acquire.\n    const written = store.repository.putRunState(runId, {",
        after:
          '    const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);\n    if (expiry !== null) return Object.freeze({ error: "busy", run_id: runId });\n    const written = store.repository.putRunState(runId, {',
      },
    ],
  },
  {
    id: "l/terminal-ledger-write-after-release",
    category: "terminal",
    mechanism: "the terminal ledger write happens after the lease is released",
    focus: { file: serviceTests, test: "launches under a lease" },
    edits: [
      {
        file: service,
        before:
          "        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership());\n        // A quota pause is the one failure",
        after: "        // A quota pause is the one failure",
      },
      {
        file: service,
        before: "        finishStretch();\n        record.settled = true;\n        if (owned) {",
        after:
          "        finishStretch();\n        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership());\n        record.settled = true;\n        if (owned) {",
      },
    ],
  },
  {
    id: "m/refused-terminal-publishes-done",
    category: "terminal",
    mechanism:
      "a stretch that lost ownership still announces a completed terminal state on the event channel",
    focus: { file: serviceTests, test: "publishes NO done event" },
    edits: [
      {
        file: service,
        before: "          // Fail-closed (errata E2): a stretch that lost ownership never",
        after:
          '          this.onEvent?.({ kind: "node", nodeId: parsed.name, state: "complete" });\n          // Fail-closed (errata E2): a stretch that lost ownership never',
      },
    ],
  },
  {
    id: "n/refused-terminal-hangs-the-waiter",
    category: "terminal",
    mechanism: "a stretch that lost ownership never settles its waiter (the bounded promise hangs)",
    focus: { file: serviceTests, test: "runAndWait resolves bounded with the errata envelope" },
    edits: [
      {
        file: service,
        before:
          "          record.published = ownershipLost(runId, fence) as unknown as Readonly<\n            Record<string, unknown>\n          >;\n          record.resolve(record.published);",
        after: "          record.settled = false;",
      },
    ],
  },
  {
    id: "r/durable-run-starts-without-a-leaf-sandbox",
    category: "sandbox",
    mechanism:
      "a durable run launches even when the runtime cannot install the leaf sandbox, so leaves run with the operator policy unenforced",
    focus: { file: serviceTests, test: "cannot install the leaf sandbox" },
    edits: [
      {
        file: service,
        before:
          "    if (install === undefined) {\n      abandonAcquisition();\n      return leafSandboxUnavailable(runId);\n    }",
        after:
          '    if (install === undefined) {\n      return Object.freeze({ run_id: runId, status: "started" as const });\n    }',
      },
    ],
  },
  {
    id: "s/superseded-stretch-keeps-granting",
    category: "sandbox",
    mechanism:
      "an older acquisition's leaf wrapper keeps granting capability after a newer acquisition owns the run",
    focus: { file: serviceTests, test: "installs one sandbox per ACQUISITION" },
    edits: [
      {
        file: service,
        before: "      if (stretch === undefined || stretch.stretchId !== stretchId) {",
        after: "      if (stretch === undefined) {",
      },
    ],
  },
  {
    id: "t/registry-guard-removed",
    category: "launch",
    mechanism: "a second engine starts on a run that is still live in this process",
    focus: { file: serviceTests, test: "falls to the registry guard" },
    edits: [
      {
        file: service,
        before:
          "    if (isLive(liveHere)) {\n      return Object.freeze({\n        error:\n          `workflow run '${runId}' has not finished",
        after:
          "    if (false as boolean) {\n      return Object.freeze({\n        error:\n          `workflow run '${runId}' has not finished",
      },
    ],
  },
  {
    id: "v/status-rebuilds-success-after-ownership-loss",
    category: "terminal",
    mechanism:
      "status ignores what the run published and rebuilds success from the engine's own outcome",
    focus: { file: serviceTests, test: "no channel reports success" },
    edits: [
      {
        file: service,
        before: "      if (record.settled && record.published !== null) return record.published;\n",
        after: "",
      },
    ],
  },
  {
    id: "w/ownerless-cancel-demands-a-virgin-fence",
    category: "cancel",
    mechanism:
      "the ownerless write also demands no fence above the presented -1, which every acquired run fails forever",
    focus: { file: repositoryTests, test: "ownerless cancel lands once the lease is gone" },
    edits: [
      {
        file: repository,
        before:
          "         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?\n         WHERE NOT EXISTS (\n           SELECT 1 FROM workflow_run_locks WHERE run_id = ? AND expires_at > ?\n         )`;",
        after:
          "         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?\n         WHERE NOT EXISTS (\n           SELECT 1 FROM workflow_run_fence WHERE run_id = ? AND fence > -1\n         )\n         AND NOT EXISTS (\n           SELECT 1 FROM workflow_run_locks WHERE run_id = ? AND expires_at > ?\n         )`;",
      },
      {
        file: repository,
        before: "        fields.updatedAt,\n        runId,\n        fields.now,\n      ];",
        after:
          "        fields.updatedAt,\n        runId,\n        runId,\n        fields.now,\n      ];",
      },
    ],
  },
  {
    id: "x/containment-resolves-only-the-parent",
    category: "sandbox",
    mechanism:
      "containment resolves the target or its immediate parent, so a link escapes when neither exists yet",
    focus: { file: sandboxTests, test: "neither the target NOR its parent exists" },
    edits: [
      {
        file: sandbox,
        before:
          "  const resolvedRoot = resolvedAgainstFilesystem(root);\n  const candidate = resolvedAgainstFilesystem(target);",
        after:
          "  const resolvedRoot = resolvedAgainstFilesystem(root);\n  const candidate = existsSync(target)\n    ? realpathSync(target)\n    : existsSync(dirname(target))\n      ? resolve(realpathSync(dirname(target)), basename(target))\n      : resolve(target);",
      },
    ],
  },
  {
    id: "y/quota-pause-drops-retry-after",
    category: "auto-resume",
    mechanism:
      "the provider's retry_after never reaches the pause payload, so the retry falls back to the backoff curve",
    focus: { file: serviceTests, test: "not at the backoff curve" },
    edits: [
      {
        file: engine,
        before: "      retryAfter === null ? null : { retry_after: retryAfter },\n    );",
        after: "    );",
      },
    ],
  },
  {
    id: "z/runandwait-waits-on-the-settled-stretch",
    category: "resume",
    mechanism: "a resume's waiter prefers the record the previous stretch already settled",
    focus: { file: serviceTests, test: "waits for the NEW stretch" },
    edits: [
      {
        file: service,
        before:
          '    const started = this.start(spec, args, options);\n    if ("error" in started) return started;\n    const target = this.runs.get(started.run_id);',
        after:
          '    const previous = this.runs.get(options.resumeRunId ?? "");\n    const started = this.start(spec, args, options);\n    if ("error" in started) return started;\n    const target = previous ?? this.runs.get(started.run_id);',
      },
    ],
  },
  {
    id: "aa/progress-never-persisted",
    category: "durable-line",
    mechanism: "the durable line stores no progress, so a cold reader loses it",
    focus: { file: serviceTests, test: "progress is persisted for a cold reader" },
    edits: [
      {
        file: service,
        before: "  return progress.total > 0 ? JSON.stringify(progress) : null;",
        after: "  void progress;\n  return null;",
      },
    ],
  },
  {
    id: "ab/taint-frozen-before-the-leaves-run",
    category: "sandbox",
    mechanism:
      "the terminal line records the taint read before the engine started, losing taint a leaf picked up",
    focus: { file: serviceTests, test: "carries the OPERATOR policy, not the spec" },
    edits: [
      {
        file: service,
        before: "        const taintedNow = tainted || this.taintTracker.tainted;",
        after: "        const taintedNow = tainted;",
      },
    ],
  },
  {
    id: "ac/release-reads-the-fence-then-deletes",
    category: "terminal",
    mechanism:
      "the release checks the fence in one statement and deletes in another, so a takeover by the same holder landing in between loses its lease",
    focus: {
      file: serviceTests,
      test: "takeover interposed between the fence check and the release",
    },
    edits: [
      {
        file: service,
        before:
          '      step("lease release", () => {\n        store.locks.releaseRunLeaseAtFence(runId, store.holder, fence);\n      });',
        after:
          '      step("lease release", () => {\n        if (Number(store.locks.runFenceOf(runId) ?? -1) === fence) {\n          store.locks.releaseRunLease(runId, store.holder);\n        }\n      });',
      },
    ],
  },
  {
    id: "ad/release-ignores-the-fence-entirely",
    category: "terminal",
    mechanism: "the release deletes by (run, holder) with no fence condition at all",
    focus: {
      file: serviceTests,
      test: "takeover interposed between the fence check and the release",
    },
    edits: [
      {
        file: service,
        before:
          '        store.locks.releaseRunLeaseAtFence(runId, store.holder, fence);\n      });\n      step("fence memory release"',
        after:
          '        store.locks.releaseRunLease(runId, store.holder);\n      });\n      step("fence memory release"',
      },
    ],
  },
  {
    id: "ae/installer-exception-keeps-the-lease",
    category: "sandbox",
    mechanism:
      "an installer that throws propagates out of start, leaving the lease held and the heartbeat renewing a run nobody tracks",
    focus: { file: serviceTests, test: "installer that throws gives the lease back" },
    edits: [
      {
        file: service,
        before:
          "    let sandboxHandle: LeafSandboxHandle;\n    try {\n      sandboxHandle = install({",
        after:
          "    let sandboxHandle: LeafSandboxHandle;\n    if (true as boolean) {\n      sandboxHandle = install({",
      },
      {
        file: service,
        before:
          "    } catch (error) {\n      abandonAcquisition();\n      this.warn(`workflow: leaf sandbox install failed for run ${runId}: ${String(error)}`);\n      return leafSandboxUnavailable(runId);\n    }",
        after: "    } else {\n      return leafSandboxUnavailable(runId);\n    }",
      },
    ],
  },
  {
    id: "af/disposal-failure-escapes-the-terminal-path",
    category: "terminal",
    mechanism:
      "a disposer that throws escapes cleanup, so the waiter never settles and the chain rejects with nobody listening",
    focus: { file: serviceTests, test: "disposer that throws still lets the run publish" },
    edits: [
      {
        file: service,
        before:
          '      // only THIS acquisition\'s installation\n      step("leaf sandbox disposal", () => {\n        sandboxHandle.dispose();\n      });',
        after: "      // only THIS acquisition's installation\n      sandboxHandle.dispose();",
      },
    ],
  },
  {
    id: "ag/cleanup-runs-once-per-path",
    category: "terminal",
    mechanism:
      "cleanup is not idempotent, so the success path and the catch path each hand the acquisition back",
    focus: { file: serviceTests, test: "publish that throws after cleanup" },
    edits: [
      {
        file: service,
        before: "      if (finished) return;\n      finished = true;",
        after: "      finished = true;",
      },
    ],
  },
  {
    id: "ah/launch-ignores-the-refused-line",
    category: "launch",
    mechanism:
      "the refused launch line is ignored, so a stretch that has already lost ownership goes on to run a leaf",
    focus: { file: serviceTests, test: "refused launch LINE alone" },
    edits: [
      {
        file: service,
        before: "    if (!registered || !seedWritten) {",
        after: "    if (!seedWritten) {",
      },
    ],
  },
  {
    id: "ai/launch-ignores-the-refused-seed",
    category: "launch",
    mechanism:
      "the refused ledger seed is ignored, so a stretch with no honest token goes on to run a leaf",
    focus: { file: serviceTests, test: "refused ledger SEED alone" },
    edits: [
      {
        file: service,
        before: "    if (!registered || !seedWritten) {",
        after: "    if (!registered) {",
      },
    ],
  },
  {
    id: "aj/launch-runs-anyway-after-the-refusal",
    category: "launch",
    mechanism:
      "the refusal is observed but the engine runs regardless, so the leaf spawns before the stretch ends",
    focus: { file: serviceTests, test: "ownership lost during install" },
    edits: [
      {
        file: service,
        before:
          "    if (!registered || !seedWritten) {\n      // Hand back ONLY this acquisition's resources",
        after:
          "    if ((false as boolean) && (!registered || !seedWritten)) {\n      // Hand back ONLY this acquisition's resources",
      },
    ],
  },
  {
    id: "ak/delivered-evidence-keeps-the-volatile-date",
    category: "evidence",
    mechanism:
      "the date rule is dropped, so an artifact captured on one day cannot be byte-compared with the next day's",
    focus: { file: serviceTests, test: "two different dates delivers identical bytes" },
    edits: [
      {
        file: normalizer,
        before: "  normalizeSystemPromptToday(parsed);",
        after: "  void parsed;",
      },
    ],
  },
  {
    id: "al/delivered-evidence-masks-more-than-declared",
    category: "evidence",
    mechanism:
      "the id rule is widened to any long hex run, which would sweep up the oracle SHA and hide real divergence",
    focus: { file: serviceTests, test: "masking nothing else" },
    edits: [
      {
        file: normalizer,
        before: '  const runIdsNormalized = text.replaceAll(RUN_ID, "$1<run-id>");',
        after: '  const runIdsNormalized = text.replaceAll(/[0-9a-f]{16,}/g, "<run-id>");',
      },
    ],
  },
  {
    id: "am/delivered-evidence-date-normalization-goes-global",
    category: "evidence",
    mechanism:
      "the date rule falls back to replaceAll over the serialized artifact and masks identical semantic text in user/tool messages",
    focus: { file: serviceTests, test: "masking nothing else" },
    edits: [
      {
        file: normalizer,
        before: "  normalizeSystemPromptToday(parsed);",
        after: '  return runIdsNormalized.replaceAll(TODAY, "$1<date>");',
      },
    ],
  },
  {
    id: "p/stretch-clock-pinned-at-acquire",
    category: "clock",
    mechanism:
      "owned writes present the clock read at ACQUIRE time, so a lease that expired mid-run still accepts its terminal write",
    focus: { file: serviceTests, test: "reads the clock AT WRITE TIME" },
    edits: [
      {
        file: service,
        before:
          "      return { fence: token, holder: store.holder, now: store.ownershipOf().now };",
        after: "      return { fence: token, holder: store.holder, now };",
      },
    ],
  },
  {
    id: "q/heartbeat-timer-is-a-noop",
    category: "clock",
    mechanism:
      "the production heartbeat is built on a no-op timer factory, so a live run never renews its lease",
    focus: { file: serviceTests, test: "token budget pause never arms auto-resume" },
    edits: [
      {
        file: service,
        before: "        { interval: store.ttl / 3, timerFactory },",
        after:
          "        { interval: store.ttl / 3, timerFactory: () => ({ cancel: () => undefined }) },",
      },
    ],
  },
  {
    id: "o/evicted-run-writes-unfenced",
    category: "fence-memory",
    mechanism:
      "a run evicted from the bounded fence memory re-reads the live fence and writes anyway",
    focus: { file: serviceTests, test: "evicting a run from the bounded fence memory" },
    edits: [
      {
        file: service,
        before: "      if (token === EVICTED) return null;",
        after:
          "      if (token === EVICTED)\n        return { fence: Number(store.locks.runFenceOf(runId) ?? 0), holder: store.holder, now: store.ownershipOf().now };",
      },
    ],
  },
];
