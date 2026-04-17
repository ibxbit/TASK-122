# LeaseHub Operations Console

> **Project type: `desktop`**  (Electron + SQLite; Dear ImGui-style
> immediate-mode UI rendered to Canvas 2D).

A fully offline, enterprise-grade desktop application.  The repository ships
with Docker orchestration so the build, headless bring-up, and test suite
run in a hermetic, network-less container — mirroring the production offline
guarantee.

### Additional Documentation

| Document | Purpose |
|----------|---------|
| [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) | Explains the Dear ImGui runtime, frame loop, widget API, input model, and per-view wiring |
| [MANUAL_VERIFICATION.md](MANUAL_VERIFICATION.md) | Step-by-step acceptance test procedures for runtime behavior that requires visual or interactive confirmation |

---

## Prerequisites

- Docker ≥ 24 with the Docker Compose plugin (`docker-compose` / `docker compose`)

**No host Node.js installation is required.**  Every build, run, and test
step executes inside the container.  The repository does not support a
local `npm install` development flow; running outside Docker is
unsupported.

---

## Quick Start (Docker-only)

```bash
# 1. Build the image and start the app service in the foreground.
docker-compose up

#    Re-run with --build the first time you clone or after Dockerfile changes:
docker-compose up --build
```

Once `docker-compose up` is running the banner prints and the container
idles.  To verify the app container came up cleanly:

```bash
# Verify — logs should show the startup phases and `bootstrap_complete`.
docker-compose logs app | grep -E 'startup_phase|bootstrap_complete|demo_credentials_seeded'

# Verify — inspect the built source inside the container.
docker-compose exec app ls /app/src/main
docker-compose exec app node --version
```

The `app` container runs with `network_mode: none` so no egress is
possible from the container runtime, and its in-process network guard
(`src/main/security/network-guard.ts`) is a defence-in-depth layer above
that.

### Access + Interact

`docker-compose up` launches the headless container.  To bring up the
graphical shell on your workstation (X11 / Wayland forwarding required),
either:

```bash
# Linux: let the container draw to your host DISPLAY.
docker-compose run --rm -e DISPLAY=$DISPLAY \
  -v /tmp/.X11-unix:/tmp/.X11-unix app npm start

# macOS / Windows: install the published .dmg / .exe produced by the
# release pipeline.  The image itself is headless; use it for dev + CI.
```

Then sign in with any of the demo credentials in the next section.

### Demo Credentials

The container starts with `LH_DEMO_SEED=1`, which idempotently seeds one
account per role on first boot in tenant **`t_default`** (name `Default`).
These credentials are stable across restarts and across fresh volumes:

| Role | Username | Password |
|------|----------|----------|
| SystemAdmin | `demo_sysadmin` | `demo-sysadmin-pass` |
| TenantAdmin | `demo_admin` | `demo-admin-pass` |
| OperationsManager | `demo_ops` | `demo-ops-pass` |
| ComplianceAuditor | `demo_auditor` | `demo-auditor-pass` |
| ContentModerator | `demo_moderator` | `demo-moderator-pass` |

Production installs set `LH_DEMO_SEED=0` (or omit it) and rely on the
first-run bootstrap, which generates a single SystemAdmin and writes the
password into `userData/initial-credentials.txt`.

---

## Services

| Service | Purpose                                | Networking           | Default command              |
|---------|----------------------------------------|----------------------|------------------------------|
| `app`   | Headless container for smoke / dev     | `network_mode: none` | Banner + `tail -f /dev/null` |
| `test`  | One-shot test runner                   | `network_mode: none` | `./run_tests.sh`             |

Both services share the `leasehub-console:latest` image built from `Dockerfile`.

---

## Testing (Docker-only)

```bash
# Full hermetic suite — unit + integration + offline-egress smoke.
docker-compose run --rm test

# Coverage mode (v8, thresholds enforced at ≥95 %):
docker-compose run --rm test ./run_tests.sh --coverage
```

Exit code is `0` only when every suite AND the offline-egress smoke pass.
The coverage thresholds (`lines / branches / functions / statements ≥ 95`)
are enforced by `vitest.config.ts`; a shortfall fails the run.

### Test layout

```
unit_tests/
├── _helpers/
│   ├── setup.ts            Global env defaults (LH_LOG_LEVEL=silent, etc.)
│   └── db.ts               makeTestDb() + seedAccessGraph() for in-memory SQLite
├── access/evaluator.test.ts            RBAC + ABAC + tenant isolation + read-only guard
├── audit/chain.test.ts                 Hash chain append, sequence, tamper detection
├── audit/export.test.ts                CSV format, manifest structure, ZIP CRC32, escH XSS, buildWhere
├── reviews/validation.test.ts          Rating / body / title / asset rules
├── reviews/moderation.test.ts          Sensitive-word scan, rate limit, duplicate text
├── contracts/template.test.ts          Variable validator + {{var:}} / {{clause:}} renderer
├── contracts/versioning.test.ts        Draft → publish → retire + cloneToNewVersion
├── contracts/signing.test.ts           pbkdf2 hash, expiry 60/30/7 milestone scan
├── scheduler/nextFireTime.test.ts      Daily + weekly fire-time math
├── scheduler/scheduler.test.ts         Start/stop lifecycle, timer cleanup, error resilience
├── routing/calc.test.ts                Distance/time/toll/cost aggregation
├── routing/optimizer.test.ts           Dijkstra + TSP + restrictions (closures, detours)
├── analytics/metrics.test.ts           Orders, revenue, occupancy, hot slots, repurchase
├── updates/signature.test.ts           RSA-SHA256 verify, manifest hash check, semver
├── perf/resources.test.ts              StatementCache / ImageBufferCache / ResourceRegistry
├── perf/startupTimer.test.ts           Cold-start phase tracking
├── recovery/restore.test.ts            Dirty-shutdown detect + snapshot validation
├── security/networkGuard.test.ts       Offline allow-list + permission deny
├── security/offlineDeep.test.ts        Dev-server carve-out, proxy direct, all URL schemes, CSP
├── shortcuts/shortcutManager.test.ts   Registration + dispatch + menu-item filtering
├── shortcuts/appMenu.test.ts           DEFAULT_SHORTCUTS, Ctrl+K/E/Shift+L dispatch, menu structure
├── tray/tray.test.ts                   Tray init, show/hide/quit, wireMinimizeToTray, menu refresh
├── windows/windowManager.test.ts       Multi-window, single-instance, DPI, nav blocking, hooks
├── session/session.test.ts             webContentsId-keyed session registry
├── bootstrap/entrypoint.test.ts        Entrypoint existence, wiring, IPC registration
├── ipc/sessionHandler.test.ts          Session store + PBKDF2 + denial/allowance
├── ipc/sessionHandler.realPath.test.ts Real handler path against in-memory DB
├── ipc/guardEnforcement.test.ts        Every sensitive channel denies without session
├── ipc/objectLevelAuth.test.ts         Handler-level object ABAC (in-scope / out-of-scope)
├── ipc/adminHandler.test.ts            TenantAdmin role + tenant isolation on admin ops
├── ipc/exportDialog.test.ts            Path validation / traversal rejection / extension match
├── access/objectLevelAbac.test.ts      recordMatchesScope fail-closed, eq/IN/OR/AND
├── audit/bundleSigner.test.ts          RSA-SHA256 sign/verify, tamper detection, cross-key
├── audit/producerPaths.test.ts         Static: no direct INSERT audit_events outside chain.ts
├── contracts/expiryService.test.ts     60/30/7 fire, dedupe, badge, chain audit, daily job
├── security/offlineEnforcement.test.ts Strict fail-closed; offline-CI profile probe
├── scheduler/executionPath.test.ts     Real fake-timer job execution + error resilience
└── imgui/runtime.test.ts               ID stack, button clicks, checkbox, inputText

integration_tests/
├── db/migrations.test.ts               Every migration applies cleanly; triggers fire
├── audit/chain_flow.test.ts            500-event chain, multi-tenant independence, head row
├── contracts/template_render_flow.test.ts   Draft → publish → render with clauses
├── reviews/moderation_flow.test.ts     Validate → persist → moderate → verdict + flag rows
├── access/enforce_flow.test.ts         Precedence: admin > ops > auditor, explicit deny
├── routing/dataset_flow.test.ts        Import signed dataset + optimise over it
├── analytics/snapshot_flow.test.ts     buildReportSnapshot returns fully-populated payload
├── updates/import_flow.test.ts         Signed package staging + version gating
├── security/offline_guard.test.ts      Allow-list contract + live egress smoke test
├── scheduler/reportJobs.test.ts        Daily + weekly report job specs
└── recovery/checkpoint_flow.test.ts    CheckpointManager writeAtomic round-trip
```

### What `run_tests.sh` does

1. **Unit tests** — runs every `unit_tests/**/*.test.{ts,tsx,js,mjs}` through
   vitest.
2. **Integration tests** — same for `integration_tests/`.  Each run gets a
   fresh `$LH_USER_DATA/test-<runid>` directory which is removed on exit
   (EXIT trap), making the script idempotent.
3. **Offline enforcement check** — fires an outbound `http.request` against
   `example.com`.  **Success counts as a failure** — if egress ever works,
   either the compose networking or the application's `network-guard.ts`
   has regressed.

Exit code is `0` only when all three steps pass.

---

## First-Run Onboarding

On the very first launch against an empty database (no `tenants` row), the
bootstrap sequence:

1. Seeds the permission catalog (21 codes across `menu.*` / `analytics.*` /
   `contract.*` / `audit.*` / `review.*` / `routing.*` / `tenant.*` /
   `system.*`).
2. Seeds the five system roles (SystemAdmin, TenantAdmin, OperationsManager,
   ComplianceAuditor, ContentModerator) and their role-permission grants.
3. Creates a tenant `t_default` (name "Default") and a SystemAdmin user
   (`admin`) with a cryptographically-random initial password.
4. Writes the username + password to
   `userData/initial-credentials.txt` (chmod 0o400).
5. Appends `bootstrap.initial_admin_provisioned` to the tenant audit chain.

After the first sign-in the admin can rotate the password via
`admin:resetPassword` and delete the credentials file.  Subsequent launches
are no-ops: the bootstrap only activates when no tenants exist.

---

## Feature Surfaces (as of the latest audit pass)

### Admin Console

* **Tenant onboarding** — SystemAdmin-only.  Visible in the Admin view
  above the Users section.  Submits via `admin:createTenant` (validated
  id format, ≥ 8-char password).  Creates tenant + TenantAdmin user +
  chain-audit `admin.tenant_created`.
* **Users / roles / policies / updates** — all prior flows unchanged.

### Dashboard

* Filter bar: `storeId`, `from` (yyyy-mm-dd), `to` (yyyy-mm-dd),
  `hourOfDay` (0–23).  The same payload feeds `analytics:snapshot`
  (on-screen) and the Ctrl+E export dialog — the ZIP reflects the
  displayed numbers.
* **Hottest seats / rooms** — a new metric computed by
  `queryHotSeatRooms` over `occupancy_snapshots ⋈ seat_rooms`, returned
  as part of `analytics:snapshot` and serialised into the CSV export.

### Reviews

* Image attachments via the main-process `files:pickImages` IPC:
  JPG/PNG only, ≤ 5 MiB per file, ≤ 5 files per review.  Files cross
  the bridge as base64 and are persisted on disk with a SHA-256
  checksum by `persistReviewAssets`.
* Follow-up form (only rendered when the parent's 14-day
  `follow_up_due_at` is still open) submits via `reviews:followUp` and
  closes the parent's follow-up window automatically.
* Late-reply override UI: after the 7-day SLA expires, an admin-only
  toggle surfaces.  A reason field is required and the resulting reply
  is audit-chained as `review.reply_late_override`.

### Routing

* Planner supports 2 → 25 dynamic stops.  `+ Add stop` extends up to
  `MAX_STOPS_CLIENT`; inline `−` removes a stop down to
  `MIN_STOPS_CLIENT`.  The UI validates the count against the same
  bounds the backend enforces.

### Keyboard shortcuts (configurable)

* `shortcuts.json` under `userData/` persists per-installation
  overrides.  The load/apply/conflict-detection code lives in
  `src/main/shortcuts/config.ts`.
* **Settings view** (`?window=settings` / search palette ⇒ "Settings")
  lets the user rebind any shortcut, restore a single default, or reset
  everything via `shortcuts:{list, set, clear, reset}`.
* Conflicting accelerators (e.g. two shortcuts mapping to `Ctrl+E`) are
  rejected with `shortcut_config:accelerator_conflict` before the menu
  is rebuilt.
* Every override change is chain-audited under the caller's tenant.

### Context menus & deep clipboard copy

Right-click is wired on the row tables of **contracts**, **reviews**,
**audit**, and **routing**.  The same `copyRowAsTsv` helper backs the
"Copy row" action across all four views so paste-into-Excel output is
identical.

---

## Migration Strategy

Migrations live under `src/main/db/migrations/` with filenames
`<NNNN>_<name>.sql`.  On every startup the versioned runner
(`src/main/db/migrate.ts`) does:

1. Creates the `schema_migrations` tracking table if missing.
2. For each migration file, compares its SHA-256 checksum against the
   applied row.  **Changed files after apply → `MigrationError:checksum_mismatch`**
   (fail-fast — no silent divergence).
3. For unapplied files, runs the SQL inside `BEGIN…COMMIT` and records the
   tracking row in the same transaction — partial apply is impossible.
4. Rejects non-monotonic version numbers and filenames without a numeric
   prefix.

To add a new migration, drop a new `000N_your_change.sql` into the folder
and restart — that's the entire workflow.

### Brownfield databases (safe baseline flow)

When the `schema_migrations` table is empty **and** the database already
contains user tables (i.e. it was created by the legacy `db.exec()` loop
that predates this runner), the runner **refuses to start** by default:

```
MigrationError: migration_error:brownfield_requires_baseline:
  database has user tables but schema_migrations is empty; set
  opts.baseline or LH_DB_BASELINE=<highest already-applied version>
  after verifying the schema is at that version. Use LH_DB_BASELINE=0
  only if you are certain every migration still needs to run.
```

The earlier "auto back-fill every file as applied" path was removed because
it silently marked **new** unapplied migrations as applied whenever a
release shipped with migrations the legacy DB had never run — causing
schema drift.  Operators now opt in explicitly:

| Situation | Action |
|-----------|--------|
| Legacy DB already at version N | Start once with `LH_DB_BASELINE=N`.  Versions 1..N are recorded without running SQL; versions > N run normally.  Subsequent starts need no env var. |
| Legacy DB but unrelated (the app's tables aren't actually present) | Start once with `LH_DB_BASELINE=0` so every migration runs. |
| Fresh install | No env var needed — the runner applies every migration in order. |

Integrity invariants preserved under baseline:

* `baseline` > max version on disk → `baseline_ahead_of_files` (fail-fast).
* `baseline` is negative / non-integer → `bad_baseline` (fail-fast).
* `schema_migrations` already has rows → `baseline_conflicts_with_existing_tracking` (fail-fast).
* Missing intermediate versions (e.g. `baseline=3` but no `0002_*.sql`) → `baseline_missing_file` (fail-fast).
* Checksum tampering of a baselined migration is detected on the next run — SHA-256 over the file contents is stored alongside the tracking row for every baselined version, so the integrity guard runs uniformly regardless of whether the row was inserted by a real apply or by a baseline.

The result is returned with a `baselined: []` array in addition to
`applied: []` / `skipped: []`, making the provenance of every tracking row
auditable.

---

## Startup Flow

The single authoritative entrypoint is `src/main/index.ts` (compiled to
`dist/main/index.js` via `tsconfig.main.json`).  Boot sequence:

```
1. Pre-ready     enableHighDpi() · perfMonitor.start() · startupTimer
2. app.whenReady
   ├── DB init   Open SQLite · apply migrations · init lifecycle
   ├── Security  installNetworkGuard() · ensureSigningKeypair()
   ├── IPC       registerSessionHandlers · registerContractHandlers
   │             registerAuditHandlers   · registerAnalyticsHandlers
   │             registerReviewsHandlers · registerRoutingHandlers
   │             registerUpdatesHandlers · registerAdminHandlers
   │             registerCanProbe
   ├── Menu      buildAppMenu() (shortcuts + accelerators)
   ├── Expiry    ExpiryService → broadcast + tray badge + audit chain
   ├── Tray      installTray() + window creation hooks
   ├── Services  checkpointer.start() · scheduler.start()
   │             (daily/weekly reports + daily expiry scan)
   └── Restore   detectDirtyShutdown() → prompt → applySession / fresh
3. Shutdown      scheduler.stop → checkpoint.stop → memorySafety.shutdown
                 → clearAllSessions
```

### Authentication & Session Lifecycle

```
Renderer                          Main Process
  |                                  |
  |-- invoke('session:login') ----->  |  verify PBKDF2 credentials
  |<-- { success, userId, roles } -- |  setSession(webContentsId, …)
  |                                  |
  |-- invoke('contracts:list') ---->  |  getSession() → evaluate() → handler
  |                                  |  ↳ no session → AccessDeniedError
  |                                  |
  |-- invoke('session:logout') ---->  |  clearSession(webContentsId)
```

### IPC Channel Registry

| Channel | Type | Handler Module | Auth |
|---------|------|---------------|------|
| `session:login` | invoke | `ipc/session.handler.ts` | None (establishes session) |
| `session:logout` | invoke | `ipc/session.handler.ts` | None |
| `session:reauth` | invoke | `ipc/session.handler.ts` | Session required |
| `session:status` | invoke | `ipc/session.handler.ts` | None |
| `access:can` | invoke | `access/enforce.ts` | Session required |
| `contracts:list` | invoke | `ipc/contracts.handler.ts` | Guarded (read) |
| `contracts:get` | invoke | `ipc/contracts.handler.ts` | Guarded (read) + object ABAC |
| `contracts:delete` | invoke | `ipc/contracts.handler.ts` | Guarded (write) + object ABAC |
| `contracts:approve` | invoke | `ipc/contracts.handler.ts` | Guarded (write) + object ABAC |
| `contracts:reject` | invoke | `ipc/contracts.handler.ts` | Guarded (write) + object ABAC |
| `contracts:sign` | invoke | `ipc/contracts.handler.ts` | Guarded (write) + object ABAC |
| `contracts:newDraft` | invoke | `ipc/contracts.handler.ts` | Guarded (write) |
| `contracts:expiring` | invoke | `ipc/contracts.handler.ts` | Guarded (read) |
| `contracts:export` | invoke | `ipc/contracts.handler.ts` | Guarded (read) |
| `contracts:open` | invoke | `ipc/contracts.handler.ts` | Guarded (read) |
| `audit:list` | invoke | `ipc/audit.handler.ts` | Guarded (read) |
| `audit:verify` | invoke | `ipc/audit.handler.ts` | Guarded (read) |
| `audit:export` | invoke | `ipc/audit.handler.ts` | Guarded (read) |
| `analytics:snapshot` | invoke | `ipc/analytics.handler.ts` | Guarded (read) |
| `analytics:export` | invoke | `ipc/analytics.handler.ts` | Guarded (read) + destination chooser |
| `reviews:list` / `:get` | invoke | `ipc/reviews.handler.ts` | Guarded (read) |
| `reviews:create` / `:moderate` / `:reply` / `:resolveFollowUp` | invoke | `ipc/reviews.handler.ts` | Guarded (write) + chain audit |
| `reviews:flags` | invoke | `ipc/reviews.handler.ts` | Guarded (read) |
| `routing:datasets` / `:activeDataset` / `:optimize` | invoke | `ipc/routing.handler.ts` | Guarded (read) |
| `routing:import` / `:activate` / `:rollback` | invoke | `ipc/routing.handler.ts` | Guarded (write) + chain audit |
| `updates:registry` / `:versions` | invoke | `ipc/updates.handler.ts` | Guarded (read, admin) |
| `updates:import` / `:rollback` / `:cancel` | invoke | `ipc/updates.handler.ts` | Guarded (write, admin) + chain audit |
| `admin:createTenant` | invoke | `ipc/admin.handler.ts` | **SystemAdmin only** + chain audit |
| `admin:*` (users, roles, scopes, policies) | invoke | `ipc/admin.handler.ts` | Guarded + role-check + chain audit |
| `reviews:followUp` | invoke | `ipc/reviews.handler.ts` | 14-day window enforced + chain audit |
| `reviews:reply` (late + override) | invoke | `ipc/reviews.handler.ts` | 7-day SLA; admin-only override with reason — both paths audited |
| `routing:resolveAddress` | invoke | `ipc/routing.handler.ts` | Address-book lookup against the active dataset |
| `routing:optimize` (addresses form) | invoke | `ipc/routing.handler.ts` | Accepts `{ addresses: string[] }`; resolves via the address book before TSP |
| `shortcut:search` / `shortcut:export` | broadcast | menu accelerators → renderer `app.ts` | Ctrl+K opens the palette; Ctrl+E triggers per-view export with destination chooser |
| `shortcuts:list` / `:set` / `:clear` / `:reset` | invoke | `ipc/shortcuts.handler.ts` | Persist keyboard-shortcut overrides; conflicts rejected; chain-audited |
| `files:pickImages` | invoke | `ipc/file-picker.handler.ts` | Renderer → main showOpenDialog for review attachments; validates mime + size up-front |
| `checkpoint:provide` | send | `recovery/checkpoint.ts` | Renderer debounces per 500 ms so state survives crashes |
| `checkpoint:restore` | broadcast | `recovery/restore.ts` → renderer | Renderer views consume `state.restoredUi` to rehydrate |

### Object-Level Authorization (ABAC)

All destructive operations (delete, approve, reject, sign) enforce
**object-level** authorization in addition to role/permission checks:

1. Fetch the target record
2. Build a record map from its attributes (org_unit_id, tenant_id)
3. Call `recordMatchesScope(record, ctx.scope)` from `access/evaluator.ts`
4. If scope check fails → `AccessDeniedError('object_scope_denied')`

This is fail-closed: if the record's attributes don't match any ABAC scope
clause, the operation is denied even if the user has the role-level permission.

### Cryptographic Signing of Audit Bundles

Audit export bundles (`audit:export`) include **RSA-SHA256 cryptographic
signatures**, not just content hashes:

1. On first run, a 2048-bit RSA keypair is generated and stored in
   `userData/keys/` (private key chmod 0o400)
2. The manifest.json is signed with the private key
3. The ZIP bundle includes: `events.csv`, `events.pdf`, `manifest.json`,
   `manifest.sig` (RSA-SHA256 signature), `signing-key.pub.pem`
4. Any verifier can check `manifest.sig` against `signing-key.pub.pem`
   to prove the manifest was not tampered with after export

---

## Project Structure

```
repo/
├── Dockerfile
├── docker-compose.yml
├── run_tests.sh
├── package.json
├── README.md
├── tsconfig.json / tsconfig.main.json
├── vite.config.ts / vitest.config.ts / tailwind.config.cjs / postcss.config.cjs
├── src/
│   ├── main/                Electron main process
│   │   ├── index.ts         ★ ENTRYPOINT — wires all subsystems
│   │   ├── logger.ts        pino wrapper (stdout + optional $LH_LOGS_DIR sink)
│   │   ├── session.ts       webContentsId-keyed session registry
│   │   ├── db/              SQLite connection, migrations, statement cleanup
│   │   ├── access/          RBAC + ABAC evaluator and enforce.ts IPC gate
│   │   ├── windows/         BrowserWindow manager (dashboard/contracts/audit)
│   │   ├── shortcuts/       Keyboard-first ShortcutManager + AppMenu
│   │   ├── tray/            System-tray module (Show / Hide / Quit)
│   │   ├── security/        Offline network guard (allow-list + permission deny)
│   │   ├── analytics/       Metrics + reports + CSV/PDF export
│   │   ├── scheduler/       Cron-style job runner (daily/weekly reports)
│   │   ├── reviews/         Validation + moderation pipeline
│   │   ├── contracts/       Template engine, versioning, PDF, signing, expiry
│   │   ├── audit/           Per-tenant hash chain + ZIP export + ★ RSA signing
│   │   ├── routing/         Offline route planning (datasets, TSP, calc)
│   │   ├── updates/         Signed-package loader + rollback registry
│   │   ├── recovery/        60-second checkpoint + restore flow
│   │   ├── resources/       StatementCache + ImageBufferCache lifecycles
│   │   ├── images/          Image buffer cleanup helpers
│   │   ├── ipc/             ★ ALL IPC handlers: session, contracts, audit,
│   │   │                        analytics, reviews, routing, updates, admin,
│   │   │                        export-dialog (destination chooser)
│   │   ├── app-lifecycle.ts Tray integration + windowAll-closed override
│   │   └── perf/            StartupTimer + PerfMonitor + MemorySafety
│   ├── preload/             Context-isolated bridge (window.leasehub)
│   └── renderer/            ★ Dear ImGui immediate-mode UI (NOT React)
│       ├── main.ts          Entry; boots the ImGui runtime on <canvas>
│       ├── index.html       Hardened CSP, canvas-only body
│       ├── index.css        Canvas sizing + reset
│       └── imgui/
│           ├── runtime.ts   ID stack, draw list, frame loop, hit-testing
│           ├── widgets.ts   beginWindow / button / inputText / beginTable / ...
│           ├── input.ts     Mouse + keyboard → FrameInput snapshot
│           ├── theme.ts     ImGuiCol_* color tokens (slate palette)
│           ├── app.ts       Frame loop host + view router
│           └── views/       dashboard · contracts · audit · reviews · routing · admin · login
├── unit_tests/              Pure-logic + in-memory SQLite tests
├── integration_tests/       Flow tests across multiple modules
└── resources/               Bundled assets (tray-icon.png, public-key.pem)
```

---

## UI/UX Flows

### Multi-window architecture

Independent `BrowserWindow` instances per logical surface, each loading the
same Dear ImGui renderer bundle with a `?window=<kind>` query string:

| Kind        | Default size  | Content                                        |
|-------------|---------------|------------------------------------------------|
| `dashboard` | 1600 × 960    | KPI strip · hot-time slots · expiring contracts|
| `contracts` | 1440 × 900    | Contract list + per-instance editor / signing |
| `audit`     | 1200 × 800    | Filterable audit log + chain-verify banner     |
| `reviews`   | 1280 × 800    | Submit / moderate / reply queue                |
| `routing`   | 1280 × 800    | Dataset list, import, activate, rollback       |
| `admin`     | 1280 × 800    | Users, roles, policies, updates                |

`WindowManager.open(kind)` is idempotent — a second call focuses the
existing window.  Every window registers a hook that wires hide-to-tray on
close, so the main process (scheduler, checkpointer, expiry scanner) keeps
running even when every window is hidden.

### Keyboard-first navigation

Accelerators live in `src/main/shortcuts/AppMenu.ts:DEFAULT_SHORTCUTS`.
They fire whenever any app window is focused:

| Accelerator   | Action                                                         |
|---------------|----------------------------------------------------------------|
| `Ctrl+K`      | Open the global search palette (renderer-side overlay)         |
| `Ctrl+E`      | Export the current view (CSV / PDF / ZIP with destination chooser) |
| `Ctrl+Shift+L`| Open / focus the Audit Log window                              |
| `Ctrl+Q`      | Quit (flips `trayManager.isQuitting` so close events pass through) |

The immediate-mode widgets own their own input handling inside the canvas
(Tab navigation, Enter to submit, Backspace in text fields, arrow keys in
tables) — consult `src/renderer/imgui/input.ts` for the concrete bindings.

### System-tray mode with background scheduler

`trayManager` (in `src/main/tray/tray.ts`) creates the tray on startup and
wires hide-on-close for every new window.  The tray menu is:

- **Show App** — restores every hidden window (or opens the dashboard if none
  are open).  Enabled only when at least one window is hidden.
- **Hide App** — hides every window.  Enabled only when at least one window
  is visible.
- **Quit**     — flips `_isQuitting` then calls `app.quit()`; the optional
  `onBeforeQuit` hook runs scheduler/checkpoint teardown before exit.

`app.on('window-all-closed')` is intercepted so the process stays alive —
the scheduler (`src/main/scheduler/Scheduler.ts`) keeps ticking and the
checkpointer keeps writing `session.json` every 60 seconds.  Daily reports
fire at 06:00 local; weekly at Mon 07:00 local.

### High-DPI scaling and layout

- `enableHighDpi()` (called once before `app.whenReady`) sets
  `high-dpi-support=1` and `force-device-scale-factor=1` so every renderer
  receives the native scale factor as a command-line argument
  (`--lh-scale=<n>`).
- Window defaults clamp to 95% of the primary work area, so 1920×1080 is
  the minimum comfortable resolution but wider displays scale up.
- `index.css` includes a hairline-border media query for ≥ 192 dpi screens
  to keep single-pixel separators crisp at 200% zoom.

### Local notifications + tray badges

Contract expiry is scanned on a schedule by `runExpiryScan()`
(`src/main/contracts/signing.ts`) which emits through a caller-supplied
`NotificationSink`:

```ts
interface NotificationSink {
  inApp(n: ExpiryNotification): void;       // broadcast to open renderers
  tray (n: ExpiryNotification): void;       // tray balloon / icon badge
}
```

The scan fires the smallest un-fired milestone per contract (7-day before
30-day before 60-day) and dedupes via the `contract_notifications` table.

---

## Offline Enforcement

Three independent layers keep the app offline:

1. **Container** — `network_mode: none` in `docker-compose.yml` strips the
   container of its network interface.
2. **Application** — `src/main/security/network-guard.ts` installs
   `session.webRequest.onBeforeRequest` with an allow-list of only `file://`
   and `app://` (plus Chromium-internal schemes).  Every redirect hop is
   re-checked.  `setPermissionRequestHandler` / `setPermissionCheckHandler`
   deny every browser-API permission so no camera / geolocation / microphone
   prompt can reach the user.  `setProxy({ mode: 'direct' })` prevents
   system proxies from tunneling traffic past the guard.
3. **Test suite** — `run_tests.sh` explicitly attempts an outbound HTTP
   request and fails the build if it succeeds.
   `integration_tests/security/offline_guard.test.ts` additionally asserts
   the allow-list contract hasn't silently grown.

---

## Manual Verification Checklist

Every requirement area has both **automated tests** and, where runtime
visual confirmation is needed, a **manual procedure**.  The summary table
below maps each area; full step-by-step instructions are in
**[MANUAL_VERIFICATION.md](MANUAL_VERIFICATION.md)**.

| # | Requirement | Automated tests | Manual procedure |
|---|-------------|-----------------|------------------|
| 1  | Tray icon + behavior          | `tray.test.ts`                                                           | MV-1 |
| 2  | Multi-window workflow         | `windowManager.test.ts`                                                  | MV-2 |
| 3  | Sign-in / session lifecycle   | `ipc/sessionHandler.realPath.test.ts`, `ipc/sessionHandler.test.ts`     | MV-3 |
| 4  | ImGui widget interactions     | `imgui/runtime.test.ts`                                                  | MV-4 |
| 5  | Contracts flow + object ABAC  | `ipc/objectLevelAuth.test.ts`, `contracts/expiryService.test.ts`        | MV-5 |
| 6  | Audit export + user-chosen destination | `audit/bundleSigner.test.ts`, `ipc/exportDialog.test.ts`, `audit/producerPaths.test.ts` | MV-6 |
| 7  | Reviews workflow              | `reviews/moderation.test.ts`, `integration_tests/reviews/moderation_flow.test.ts` | MV-7 |
| 8  | Routing dataset flow          | `integration_tests/routing/dataset_flow.test.ts`                         | MV-8 |
| 9  | Admin / updates               | `ipc/adminHandler.test.ts`                                               | MV-9 |
| 10 | Offline guarantee             | `security/offlineEnforcement.test.ts`, `integration_tests/security/offline_guard.test.ts` | MV-10 |

For the Dear ImGui runtime architecture, see
**[UI_ARCHITECTURE.md](UI_ARCHITECTURE.md)**.

---

## Verifying Core Features

After `docker-compose up`:

```bash
# Banner + environment info
docker-compose logs app

# Source tree mounted and built
docker-compose exec app ls /app/src/main

# Verify Node + build artefacts
docker-compose exec app node --version
docker-compose exec app ls /app/dist 2>/dev/null || echo 'no build yet'
```

After `docker-compose run --rm test`:

- Exit code `0` → all suites plus the offline check passed.
- Log output reports the suite breakdown; `grep -E '(PASS|FAIL)' run.log`
  summarises.

---

## npm Scripts (internal — run inside the container)

The npm scripts below are invoked by `run_tests.sh` and the build
pipeline **inside the container**.  The repository does not support a
host-local `npm install` + `npm test` workflow; use `docker-compose`
instead (see Quick Start).  The scripts are documented here only so
maintainers editing the Dockerfile / `run_tests.sh` know what each
target does.

| Script                  | Purpose                                      |
|-------------------------|----------------------------------------------|
| `build`                 | Build main + renderer (production bundles)   |
| `test`                  | Unit + integration                           |
| `test:unit`             | Vitest over `unit_tests/`                    |
| `test:integration`      | Vitest over `integration_tests/`             |
| `typecheck`             | `tsc --noEmit`                               |

---

## Troubleshooting

| Symptom                                           | Likely cause + fix                                                                 |
|---------------------------------------------------|-------------------------------------------------------------------------------------|
| `npm ci` fails during build                       | Host is offline — build requires network to fetch dependencies.                    |
| `better-sqlite3` rebuild fails                    | Base image includes `python3 make g++`; if you customised the Dockerfile, restore those. |
| `OFFLINE CHECK FAILURE` in tests                  | Compose networking regressed — confirm `network_mode: none` on both services.      |
| `app` container exits immediately                 | A custom `command:` overrode the default; the default keeps it alive with `tail -f`.|
| Test data accumulates across runs                 | Shouldn't happen — `run_tests.sh` uses an EXIT trap.  Drop the volume: `docker-compose down -v`. |
| `cannot find module '../db'` on typecheck         | `src/main/db/index.ts` re-exports the DB singleton; regenerate after a pull.       |

---

## License

Proprietary — internal enterprise tool.
