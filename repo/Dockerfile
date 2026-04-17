# ============================================================================
# LeaseHub Operations Console — container image
#
# Supports:
#   docker compose up           → runs the `app` service (banner + idle)
#   docker compose run test     → runs the unit + integration test suite
#
# Offline enforcement:
#   Build-time network is used only to fetch npm dependencies.
#   Runtime containers have `network_mode: none` (see docker-compose.yml),
#   so the offline app guarantee is mirrored by the CI environment.
# ============================================================================

FROM node:20-bookworm-slim

# Native build chain for better-sqlite3 + bash for run_tests.sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 make g++ bash ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer — cached unless package.json changes.
COPY package.json package-lock.json* ./
RUN (npm ci --no-audit --no-fund) || (npm install --no-audit --no-fund)

# Source + optional build (tolerate missing build script during scaffolding).
COPY . .
RUN chmod +x ./run_tests.sh \
 && (npm run build --if-present || echo "no build script — continuing")

# Runtime data location — mounted as a volume so state survives restarts.
RUN mkdir -p /data/userData /data/logs

ENV NODE_ENV=production \
    CI=true \
    LH_USER_DATA=/data/userData \
    LH_LOGS_DIR=/data/logs

# tini as PID 1 for clean signal handling (ctrl-c on `docker compose up`).
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default CMD prints a banner + stays alive so `docker compose up` doesn't
# exit immediately.  The `test` service overrides this with run_tests.sh.
CMD ["sh", "-c", "\
  echo '=============================================================='; \
  echo ' LeaseHub Operations Console - container ready'; \
  echo '  node:       '$(node --version); \
  echo '  user data:  '$LH_USER_DATA; \
  echo '  logs:       '$LH_LOGS_DIR; \
  echo '  CI:         '$CI; \
  echo '=============================================================='; \
  exec tail -f /dev/null \
"]
