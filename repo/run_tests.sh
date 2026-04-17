#!/usr/bin/env bash
# ============================================================================
# LeaseHub Operations Console — test runner
#
#   1. Unit tests         (unit_tests/**/*.test.{ts,tsx,js})
#   2. Integration tests  (integration_tests/**/*.test.{ts,tsx,js})
#   3. Offline enforcement check (verifies no egress is possible)
#
# Idempotent:
#   - creates a per-run data directory; removes it on exit (trap)
#   - skips test buckets cleanly when their directory is empty / missing
#   - exits non-zero on the first failure, but still runs every bucket
# ============================================================================

set -uo pipefail

RUNID=$(date +%s)
export LH_USER_DATA="${LH_USER_DATA:-/tmp/lh-userdata}"
export LH_LOGS_DIR="${LH_LOGS_DIR:-/tmp/lh-logs}"
TEST_DATA_DIR="$LH_USER_DATA/test-$RUNID"

cleanup() { rm -rf "$TEST_DATA_DIR" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$TEST_DATA_DIR" "$LH_LOGS_DIR"

echo "=============================================================="
echo " LeaseHub Operations Console - Test Suite"
echo "--------------------------------------------------------------"
echo " node:       $(node --version)"
echo " run id:     $RUNID"
echo " user data:  $TEST_DATA_DIR"
echo " logs:       $LH_LOGS_DIR"
echo "=============================================================="

FAILED=0

has_tests() {
  local dir="$1"
  [ -d "$dir" ] && find "$dir" -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.mjs' \) 2>/dev/null | grep -q .
}

# ── 1. Unit tests ──────────────────────────────────────────────────────────
echo
echo "--- 1/3 Unit tests ---"
if has_tests "unit_tests"; then
  if ! LH_USER_DATA="$TEST_DATA_DIR" \
       npx --no-install vitest run unit_tests --reporter=verbose; then
    echo "FAIL: unit tests"
    FAILED=$((FAILED + 1))
  fi
else
  echo "skipped (unit_tests/ empty or missing)"
fi

# ── 2. Integration tests ───────────────────────────────────────────────────
echo
echo "--- 2/3 Integration tests ---"
if has_tests "integration_tests"; then
  if ! LH_USER_DATA="$TEST_DATA_DIR" \
       npx --no-install vitest run integration_tests --reporter=verbose; then
    echo "FAIL: integration tests"
    FAILED=$((FAILED + 1))
  fi
else
  echo "skipped (integration_tests/ empty or missing)"
fi

# ── 3. Offline enforcement ────────────────────────────────────────────────
echo
echo "--- 3/3 Offline enforcement check ---"
if ! node -e "
  const http = require('node:http');
  const req = http.request(
    { host: 'example.com', port: 80, timeout: 2000, method: 'GET', path: '/' },
    (res) => {
      console.error('FAIL: egress succeeded (status ' + res.statusCode + ')');
      process.exit(1);
    },
  );
  req.on('error',   (e) => { console.log('OK: egress blocked  (' + e.code + ')'); process.exit(0); });
  req.on('timeout', ()  => { req.destroy(); console.log('OK: egress timed out'); process.exit(0); });
  req.end();
"; then
  echo "FAIL: offline enforcement"
  FAILED=$((FAILED + 1))
fi

echo
echo "=============================================================="
if [ "$FAILED" -eq 0 ]; then
  echo " PASS - all suites green"
  exit 0
else
  echo " FAIL - $FAILED suite(s) failed"
  exit 1
fi
