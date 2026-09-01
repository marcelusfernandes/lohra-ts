#!/bin/sh
set -eu

lock_dir=/tmp/lohra-parity-11434.lock
owner_file=$lock_dir/owner
owner_token="agent=851a4905-09a4-4c62-bcc8-628f07620463 pid=$$ utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "T19_LOCK_BUSY:$(test -f "$owner_file" && tr '\n' ' ' < "$owner_file" || echo owner-unavailable)" >&2
  exit 75
fi

release_lock() {
  if test -f "$owner_file" && test "$(tr '\n' ' ' < "$owner_file" | sed 's/ $//')" = "$owner_token"; then
    rm -f "$owner_file"
    rmdir "$lock_dir"
  fi
}
trap release_lock EXIT HUP INT TERM

printf '%s\n' "$owner_token" > "$owner_file"
if test "$(tr '\n' ' ' < "$owner_file" | sed 's/ $//')" != "$owner_token"; then
  echo "T19_LOCK_OWNERSHIP_CONFIRMATION_FAILED" >&2
  exit 75
fi

# A lock coordinates cooperating lanes; it does not prove the sockets are
# actually unused. Fail closed before starting any gate if a fixed listener is
# already present, and let the trap release only this invocation's lock.
for port in 11434 9119 8000; do
  if /usr/bin/nc -z -w 1 127.0.0.1 "$port" >/dev/null 2>&1; then
    echo "PRECONDITION_TCP_PORT_IN_USE:$port" >&2
    exit 75
  fi
done

# Acquisition, both T19 suites, the complete unit suite, aggregate parity
# gates, and release share this one shell invocation. Until T13 is integrated,
# the one approved deferred chat scenario is allowed to finish its evidence
# run, but the wrapper still exits non-zero after every other gate completes.
chat_blocked=0
chat_exit=0
npm run parity:t19 || chat_exit=$?
if test "$chat_exit" -eq 1; then
  node -e '
    const evidence = require("./.parity-evidence/t19/t19-chat-bilateral.json");
    const failed = evidence.results.filter((result) => result.pass === false).map((result) => result.id);
    if (evidence.failures !== 1 || JSON.stringify(failed) !== JSON.stringify(["t19-child-with-mcp-8-tools"])) {
      process.stderr.write(`T19_UNEXPECTED_CHAT_FAILURES:${JSON.stringify(failed)}\n`);
      process.exit(1);
    }
  '
  chat_blocked=1
elif test "$chat_exit" -ne 0; then
  echo "T19_CHAT_SUITE_FAILED:$chat_exit" >&2
  exit "$chat_exit"
fi

npm run parity:t19:process
npm test
npm run parity:t19:gates:raw

if test "$chat_blocked" -eq 1; then
  echo "T19_BLOCKED_DEFERRED:t19-child-with-mcp-8-tools:requires-approved-T13-integration" >&2
  exit 1
fi
