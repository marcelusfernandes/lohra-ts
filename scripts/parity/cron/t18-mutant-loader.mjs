// Mutation-kill probes for T18's masked-field self-test (assertion 44) and
// the fail-closed guard self-test (assertion 24). Loaded via `node --import
// t18-mutant-loader.mjs dist/cli.js cron ...` (mirrors T11's
// candidate-launcher.mjs pattern) or imported directly by the scheduler
// launcher: patches CronStore.prototype BEFORE any store instance is
// constructed, selected by T18_MUTANT. Each mutant exists only inside the
// mutated process -- the product source is never touched, so the delivery
// worktree stays clean and runGuards()'s porcelain check keeps holding.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import process from "node:process";

import { CronStore } from "../../../dist/cron/store.js";

const mutant = process.env.T18_MUTANT;
if (mutant === undefined) throw new Error("T18_MUTANT is required for this loader");

// --- id (probe 24): breaks "added job <32-hex>" on stdout only, the exact
// format regex every cli-bilateral scenario checks -- proves masking still
// requires the RIGHT shape, not just presence.
if (mutant === "id") {
  const originalAdd = CronStore.prototype.add;
  CronStore.prototype.add = function patchedAdd(input) {
    const job = originalAdd.call(this, input);
    return { ...job, id: job.id.slice(0, 8) };
  };
}

// --- created_at (probe 25): pins the wall-clock so a window-bound sanity
// check (the only real comparison this field has, since no CLI surface ever
// prints it) fails.
if (mutant === "createdat") {
  Date.now = () => 0;
}

// --- last_run_at (probe 26, decision 13's own named example): a run always
// reports itself as never-having-happened, so a restart re-fires an
// already-fired job.
if (mutant === "markrun") {
  CronStore.prototype.markRun = () => true;
}

// --- destroy (assertion 24's first named mutation): silently replicates the
// oracle's "destroy" behavior on `add` over any of the 16 fail-closed forms,
// instead of refusing -- the candidate's whole ADR-divergence claim rests on
// this NEVER happening.
if (mutant === "destroy") {
  const originalAdd = CronStore.prototype.add;
  CronStore.prototype.add = function patchedAdd(input) {
    try {
      return originalAdd.call(this, input);
    } catch {
      const job = {
        id: randomUUID().replaceAll("-", ""),
        name: input.name,
        prompt: input.prompt,
        type: input.type,
        value: input.value,
        enabled: true,
        created_at: Date.now() / 1000,
        last_run_at: null,
      };
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = join(dirname(this.path), `.jobs-${randomUUID()}.json.tmp`);
      writeFileSync(tmp, JSON.stringify({ jobs: [job] }), "utf8");
      renameSync(tmp, this.path);
      return job;
    }
  };
}

// --- preserve-append (assertion 24's second named mutation): blindly
// appends past whatever raw bytes were readable, without validating entries
// -- the oracle's "preserve-and-append" behavior applied where the ADR
// requires refusal instead.
if (mutant === "preserve-append") {
  const originalAdd = CronStore.prototype.add;
  CronStore.prototype.add = function patchedAdd(input) {
    try {
      return originalAdd.call(this, input);
    } catch {
      let existingJobs = [];
      try {
        const raw = readFileSync(this.path, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.jobs)) existingJobs = parsed.jobs;
      } catch {
        existingJobs = [];
      }
      const job = {
        id: randomUUID().replaceAll("-", ""),
        name: input.name,
        prompt: input.prompt,
        type: input.type,
        value: input.value,
        enabled: true,
        created_at: Date.now() / 1000,
        last_run_at: null,
      };
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = join(dirname(this.path), `.jobs-${randomUUID()}.json.tmp`);
      writeFileSync(tmp, JSON.stringify({ jobs: [...existingJobs, job] }), "utf8");
      renameSync(tmp, this.path);
      return job;
    }
  };
}
