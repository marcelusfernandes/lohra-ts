// ints() truncates 2**53 to 9007199254740992 (safe BigInt? No: 2**53 = 9007199254740992 which IS > MAX_SAFE 9007199254740991)
// safeInteger only fires on READ not bind. So the write succeeds — no throw. 
// Decision: validate cost parts on WRITE in putCacheCellWithCost — but is that T16 semantic? Oracle: int columns silently hold big ints.
// The contract's "exceção no custo → rollback desfaz a célula e propaga" needs a real exception. Simpler: negative tokens violate nothing in SQLite.
// Real exception source: trigger-based guard is out of scope. Instead pin: unsafe cost value (non-integer) throws in ints/safeInteger validation added on write.
