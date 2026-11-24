#!/bin/sh
# The slow suites: real Pi sessions on this machine and over SSH, and the app driven through its UI.
# A throwaway sshd on 127.0.0.1 (test/sshd.sh, host alias "iris-test") stands in for a remote machine;
# every model answer comes from a mock on localhost. Build the renderer first (npm run test:integration does).
set -eu
cd "$(dirname "$0")/.."
SSHD_DIR=${IRIS_SSHD_DIR:-/tmp/iris-sshd}
CONFIG=$SSHD_DIR/ssh_config

rm -f "$CONFIG"
sh test/sshd.sh > "$SSHD_DIR.log" 2>&1 &
SSHD=$!
trap 'kill $SSHD 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  [ -f "$CONFIG" ] && ssh -F "$CONFIG" iris-test true 2>/dev/null && break
  sleep 0.2
done
ssh -F "$CONFIG" iris-test true || { echo "The test SSH server did not start:"; cat "$SSHD_DIR.log"; exit 1; }

FAILED=""
run() { echo; echo "== $*"; "$@" || FAILED="$FAILED\n  $*"; }
run node test/history-ssh.mjs
run node test/protocol.mjs --ssh-host iris-test --ssh-config "$CONFIG"
run node test/relay.mjs --ssh-config "$CONFIG"
run node test/latency.mjs --ssh-config "$CONFIG"
# In the UI suite Pi reaches the test host by upload from this machine (no npm registry round trips).
run env IRIS_FORCE_PI_UPLOAD=1 node test/e2e.mjs --ssh-config "$CONFIG"
run node test/runtime-ui.mjs
run node test/history-ui.mjs
[ -z "$FAILED" ] || { printf "\nFailed:$FAILED\n"; exit 1; }
echo; echo "All integration suites passed."
