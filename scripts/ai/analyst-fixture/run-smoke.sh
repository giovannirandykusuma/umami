#!/bin/sh
# Real authenticated offline create+repair smoke against the synthetic fixture app.
# Works with any inherited TMPDIR (including a repo-internal scratch dir): app.mjs places the
# sanitized project, HOME and TMPDIR under the validated platform system temp, never $TMPDIR.
# Owned cleanup: app.mjs removes its unique mkdtemp project on exit; this script stops the app.
# Usage: AI_PI_ROOT=/abs/pinned/pi sh scripts/ai/analyst-fixture/run-smoke.sh [port]
set -eu
port=${1:-3338}
: "${AI_PI_ROOT:?absolute pinned Pi install required}"
sh scripts/ai/analyst-fixture/setup.sh >/dev/null
ANALYST_FIXTURE_PORT=$port node scripts/ai/analyst-fixture/app.mjs >"${TMPDIR:-/tmp}/analyst-fixture-app.log" 2>&1 &
app=$!
trap 'kill $app 2>/dev/null; wait $app 2>/dev/null || true' EXIT INT TERM
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/api/auth/verify")" = 401 ]; do
  i=$((i + 1))
  [ $i -lt 120 ] || { echo 'fixture app not ready' >&2; tail -20 "${TMPDIR:-/tmp}/analyst-fixture-app.log" >&2; exit 1; }
  sleep 2
done
head -1 "${TMPDIR:-/tmp}/analyst-fixture-app.log"
ANALYST_FIXTURE_ORIGIN="http://127.0.0.1:$port" node scripts/ai/analyst-fixture/smoke.mjs
