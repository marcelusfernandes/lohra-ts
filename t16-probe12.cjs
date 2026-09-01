// The difference from probe9: the test first does writeState(first) SUCCESSFULLY at fence 1
// (which INSERT OR REPLACEs row), releases, reacquires p2, then writeState(second).
// Identical to probe9... except writeState passes `updatedAt: ownership.now` = 1001 AND now: 1001,
// while p2's lease expires_at = 1101 > 1001 fine. Hmm, but wait — second=owned(...) gives now:1001.
// Put exact repro incl. specJson/argsJson/tokenBudget/tainted columns... probe9 did that.
// One diff: writeState passes owner: ownership.holder — 'p2'. probe9 same. So why fail?
// → Maybe the test's `first` was acquired with ttl 50 and p1 released... then p2 acquire at now=1001 with DELETE expires<=1001.
// In the TEST, first lease ttl=50 → expires 1050. releaseRunLease deletes it. Then p2 acquires at 1001.
// Probe9 matched this and worked. So maybe warning() in the test repo instance is shared and writeState in test passes fence undefined?
// Actually: repo() creates repository BEFORE locks. Both share connection. Fine.
// AH WAIT: test line 92-94: writeState(first) succeeds; release; then acquire p2 → fence 2.
// writeState(second) → fence: 2, holder p2, now 1001. ownedWrite JOIN fence f.fence=2, locks l.holder=p2 expires>1001 ✓.
// Should be 1 change... unless writeState helper spreads wrong: writeState(repository, "run", second) — but helper signature
// has runId param! I called writeState(repository, "run", second) — correct.
// Let me check LockRepository vs WorkflowRepository warning double-instance... irrelevant.
// Actually check: acquireRunLease at 1001 with DELETE expires_at <= 1001: p1's lease was RELEASED (deleted) already.
// Fence bump: fence 1 → 2. second.fence = 2. Hmm.
// !!!! The helper writes owner: ownership.holder but the FIRST write at line 92 already wrote run row with fence guard via ownedWrite...
