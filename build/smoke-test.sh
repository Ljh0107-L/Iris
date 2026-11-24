#!/bin/sh
# Starts the packaged app with a throwaway profile and waits for it to report that the window loaded, the
# terminal module works and a Pi session starts (main.mjs smokeTest). Usage: sh build/smoke-test.sh <Iris.app>
set -eu
APP=${1:?path to Iris.app}
LOG=$(mktemp)
codesign --verify --deep --strict "$APP"
IRIS_SMOKE_TEST=1 IRIS_USER_DATA=$(mktemp -d) IRIS_INSECURE_TEST_STORAGE=1 "$APP/Contents/MacOS/Iris" > "$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 90); do grep -q "IRIS SMOKE" "$LOG" && break; sleep 1; done
wait "$PID" || true
cat "$LOG"
grep -q "IRIS SMOKE OK" "$LOG"
