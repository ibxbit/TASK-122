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

# When invoked on a clean host (evaluator runs this script directly), the
# repo's node_modules may not exist yet.  `vitest.config.ts` imports from
# 'vitest/config', which Node resolves relative to the config file — so a
# pure `npx -y vitest` fallback isn't enough; we need vitest installed
# INTO this repo's node_modules.  Install once, then proceed.
if [ ! -d "./node_modules/vitest" ]; then
  echo " installing dependencies (npm install) ..."
  if ! npm install --no-audit --no-fund; then
    echo "FAIL: npm install could not install dependencies"
    exit 1
  fi
fi

# Self-repair zero-byte chunks.
#
# npm + BuildKit cache layers have occasionally produced 0-byte .js files
# under disk pressure (the chunked stream gets truncated mid-install).
# The vitest 2.x bundles include `utils.*.js` chunks that are small but
# required — any of them being 0 bytes gives:
#     TypeError: Cannot destructure property 'divider' of '(intermediate
#     value)' as it is undefined
# which is opaque and masquerades as a vitest bug.  Detect + reinstall
# before running any suite.
if find node_modules/vitest -type f -name '*.js' -size 0 2>/dev/null | grep -q . ; then
  echo " detected 0-byte chunks in node_modules/vitest - repairing ..."
  rm -rf node_modules/vitest node_modules/@vitest 2>/dev/null || true
  if ! npm install --no-audit --no-fund --force; then
    echo "FAIL: npm install (repair) could not reinstall dependencies"
    exit 1
  fi
  if find node_modules/vitest -type f -name '*.js' -size 0 2>/dev/null | grep -q . ; then
    echo "FAIL: 0-byte chunks persist after repair"
    exit 1
  fi
fi

# Resolve the vitest CLI directly.  `npx --no-install` changed shape in
# npm 10 and fails to find the bin symlink when the lockfile was generated
# with a different npm major, which is exactly what happened in CI.  Call
# the installed entry script ourselves; fall back to `npx -y` on a clean
# checkout where node_modules is empty.
#
# dist/cli.js is tried FIRST because the top-level `vitest.mjs` in
# vitest@2 depends on a dynamic-import chunk that fails on some installs
# (TypeError: Cannot destructure property 'divider' of '(intermediate
# value)').  dist/cli.js bypasses that shim.
if [ -f "./node_modules/vitest/dist/cli.js" ]; then
  VITEST_CMD="node ./node_modules/vitest/dist/cli.js"
elif [ -f "./node_modules/vitest/vitest.mjs" ]; then
  VITEST_CMD="node ./node_modules/vitest/vitest.mjs"
elif [ -x "./node_modules/.bin/vitest" ]; then
  VITEST_CMD="./node_modules/.bin/vitest"
else
  VITEST_CMD="npx -y vitest"
fi
echo " vitest cmd: $VITEST_CMD"

has_tests() {
  local dir="$1"
  [ -d "$dir" ] && find "$dir" -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.mjs' \) 2>/dev/null | grep -q .
}

# ── 1. Unit tests ──────────────────────────────────────────────────────────
echo
echo "--- 1/3 Unit tests ---"
if has_tests "unit_tests"; then
  if ! LH_USER_DATA="$TEST_DATA_DIR" \
       $VITEST_CMD run unit_tests --reporter=verbose; then
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
       $VITEST_CMD run integration_tests --reporter=verbose; then
    echo "FAIL: integration tests"
    FAILED=$((FAILED + 1))
  fi
else
  echo "skipped (integration_tests/ empty or missing)"
fi

# ── 3. Offline enforcement ────────────────────────────────────────────────
# Only meaningful inside the sandboxed `test` service (network_mode: none).
# On a host/CI runner the machine has real network, so the probe would
# always "fail" in a way that says nothing about the app's offline
# guarantee.  Detect the container environment and skip otherwise.
echo
echo "--- 3/3 Offline enforcement check ---"
IN_DOCKER=0
if [ -f /.dockerenv ] || [ -n "${LH_FORCE_OFFLINE_CHECK:-}" ]; then
  IN_DOCKER=1
fi
if [ "$IN_DOCKER" -ne 1 ]; then
  echo "skipped (host environment - offline enforcement is verified inside the Docker 'test' service, which runs with network_mode: none)"
else
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
