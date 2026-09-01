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

# Acquisition, the complete unit suite, aggregate parity gates, and release
# share this one shell invocation.
npm test
npm run parity:t19:gates:raw
