#!/bin/sh
set -eu
umask 077
: "${CANON_WORK_DIR:?Set CANON_WORK_DIR}"
: "${CANON_RELEASE:?Set CANON_RELEASE}"
: "${CANON_NODE:?Set CANON_NODE}"
: "${CANON_BOOTSTRAP:?Set CANON_BOOTSTRAP}"
: "${CANON_SECRETS:?Set CANON_SECRETS}"
export CANON_BOOTSTRAP CANON_SECRETS
test "$(id -u)" -ne 0
command -v flock >/dev/null
mkdir -p "$CANON_WORK_DIR/logs"
exec 9>"$CANON_WORK_DIR/supervisor.lock"
flock -n 9 || exit 0
pidfile="$CANON_WORK_DIR/supervisor.pid"
log="$CANON_WORK_DIR/logs/daemon.log"
printf '%s\n' "$$" >"$pidfile"
child=
stop() {
  trap '' HUP INT TERM
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || :
    wait "$child" || :
  fi
  exit 0
}
trap 'rm -f "$pidfile"' EXIT
trap stop HUP INT TERM
cd "$CANON_RELEASE"
while :; do
  # DSM log retention for this low-volume startup/error stream.
  if [ -f "$log" ] && [ "$(wc -c <"$log")" -ge 1048576 ]; then
    mv -f "$log" "$log.1"
  fi
  "$CANON_NODE" dist/main.js >>"$log" 2>&1 &
  child=$!
  wait "$child" || :
  child=
  sleep 15 &
  child=$!
  wait "$child" || :
  child=
done
