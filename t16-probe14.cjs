// Hypothesis: first lease acquired with ttl=50 at now=1000 → expires 1050.
// p1 releases. p2 acquires at now=1001, ttl=100 → expires 1101.
// BUT: acquire's DELETE is "expires_at <= now" (1001) — fine.
// Hmm wait, in the TEST first=owned(acquire('p1',1000,50)) → fence 1.
// writeState(first) at line 92 with now 1000 → SUCCESS (row inserted).
// release p1. acquire p2 at 1001 → fence 2.
// writeState(second): fence=2, holder='p2', now=1001.
// writeState builds: fence: ownership.fence — the helper maps fields.fence=2, holder p2, now=1001.
// ownedWrite JOIN l.expires_at > 1001 → 1101 > 1001 ✓. f.fence=2 = current ✓.
// UNLESS... the helper is called with the OLD repo closure? No...
// OR: the first test writeState(first) went through the UNLEASED path? No — requireUnleased undefined.
// Wait — could putRunState be hitting putRunState's ownerless branch because... no.
// DIFFERENT IDEA: line 68 acquired at now=1000 ttl=100 in test #1 — but test #2 acquires with ttl=50.
// In test #2, after writeState(first) success and release, acquire('p2', 1001, 100):
// DELETE expires <= 1001: p1's lease was already deleted by release. OK.
// Then fence bump 1→2. So second = {fence: 2, holder 'p2', now 1001}.
// writeState uses updatedAt: second.now = 1001 and now: 1001.
// Everything checks. So maybe the test's `first` variable reuse: line 91 const first = owned(...1000, 50) — but I reference
// `first` inside writeState? No.
// Actually! Maybe the FAILURE is at a later line: the error message says line 99 writeState(second) returned false.
// Write refusal fires when changes=0 OR locked. Could INSERT OR REPLACE collide with UNIQUE on fence bump?
// Let me just add debug: run the test file with a modified copy printing the warning.
