# Manual Verification Procedures

Step-by-step acceptance procedures for runtime behaviour that cannot be
fully exercised by the automated suite.  Run these after `npm test` exits
green.  Each procedure is self-contained and takes < 2 minutes.

> **MV-1..MV-10** cover the original acceptance surfaces.
> **MV-11..MV-16** cover the workflows added in the latest audit pass
> (admin tenant onboarding, dashboard filters/hot seats, reviews
> attachments/follow-up/override, routing dynamic stops, configurable
> shortcuts, expanded context menus).

---

## MV-1: System Tray Icon & Behaviour

Automated coverage: `unit_tests/tray/tray.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | `npm start` | Tray icon visible (real 16×16 PNG from `resources/tray-icon.png`) |
| 2 | Hover tray icon | Tooltip: `LeaseHub Operations Console` |
| 3 | Double-click tray | Dashboard window restores / opens |
| 4 | Right-click tray | Menu: **Show App** (disabled), **Hide App** (enabled), separator, **Quit** |
| 5 | Click **Hide App** | All windows hide; **Show App** becomes enabled |
| 6 | Click **Show App** | Windows reappear |
| 7 | Trigger expiry scan (seed contract @ 6 days) | Tooltip updates to `… (N pending)` |
| 8 | Click **Quit** | Process exits cleanly |

---

## MV-2: Multi-Window Workflow

Automated coverage: `unit_tests/windows/windowManager.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | `npm start` | Dashboard window (immediate-mode rendered into canvas) |
| 2 | Menu → Go → Contract Workspace | Second window opens with its own ImGui loop |
| 3 | Open Audit from menu | Third window opens; existing ones stay open |
| 4 | Re-open any kind | Focuses the existing window (idempotent open) |

---

## MV-3: Sign-In Flow

Automated coverage: `unit_tests/ipc/sessionHandler.realPath.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Launch app cold | Login view renders (no session) |
| 2 | Submit empty creds | Banner: `Sign-in failed: missing_credentials` |
| 3 | Submit wrong password | Banner: `Sign-in failed: invalid_credentials` |
| 4 | Submit valid creds | Dashboard opens; status strip shows "Signed in as <user>" |
| 5 | Click **Sign Out** | Login view reappears |

---

## MV-4: Keyboard + ImGui Widget Interactions

Automated coverage: `unit_tests/imgui/runtime.test.ts` (ID stack, button
click detection, checkbox toggle, inputText + Backspace).

| Step | Action | Expected |
|------|--------|----------|
| 1 | Click into a text input | Cursor blinks; focus ring appears |
| 2 | Type characters | Text appears in the buffer |
| 3 | Press Backspace | Last character removed |
| 4 | Click outside input | Focus released; cursor stops blinking |
| 5 | Click buttons (Refresh, Export) | Release inside triggers the action; release outside does not |
| 6 | Click table row | Row becomes selected (ImGui selectable state) |

---

## MV-5: Contracts Flow

Automated coverage: `unit_tests/ipc/objectLevelAuth.test.ts`,
`unit_tests/contracts/expiryService.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Contracts view — click New Draft | Row appears with status `draft` |
| 2 | Select row, click Approve | Status becomes `pending_signature` |
| 3 | Enter password, click Sign & activate | Status becomes `active`; chain-audit row created |
| 4 | Login as scoped ops user (loc_nyc only) | Out-of-scope contracts are denied on action |

---

## MV-6: Audit Log + Export

Automated coverage: `unit_tests/audit/bundleSigner.test.ts`,
`unit_tests/ipc/exportDialog.test.ts`,
`unit_tests/audit/producerPaths.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Audit view | Green banner: `Chain verified — N events` |
| 2 | Click Export ZIP | OS save dialog opens |
| 3 | Choose destination folder | Dialog closes; banner shows `Export written: <path>` |
| 4 | Verify ZIP contains `manifest.json`, `manifest.sig`, `signing-key.pub.pem` | ✓ |
| 5 | Tamper with `manifest.json` in a copy of the ZIP | Verification fails externally |

---

## MV-7: Reviews

Automated coverage: `unit_tests/reviews/moderation.test.ts`,
`integration_tests/reviews/moderation_flow.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Submit review with rating 5, normal body | Banner: `Review submitted (moderation in progress)` |
| 2 | Submit 4 reviews within 10 min | 4th triggers rate_limit flag → moderation quarantined |
| 3 | Click row, post reply within 7 days | Reply posted; `withinSla=true` |
| 4 | Click Approve | Status `approved`; chain-audit row `review.approve` |

---

## MV-8: Routing

Automated coverage: `integration_tests/routing/dataset_flow.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enter USB dataset path; click Import | Dataset appears, audit row `routing.dataset_imported` |
| 2 | Click a non-active dataset row | Activated; audit row `routing.dataset_activated` |
| 3 | Click Rollback | Previous dataset becomes active; audit row `routing.dataset_rollback` |

---

## MV-9: Admin Policies & Updates

Automated coverage: `unit_tests/ipc/adminHandler.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create user | User appears in table; audit row `admin.user_created` |
| 2 | Grant Role | Audit row `admin.role_granted` |
| 3 | Add policy word | Row appears in moderation dictionary |
| 4 | Import update (signed package path) | Versions list updated; `updates.json` pending=install |
| 5 | Queue rollback | `updates.json` pending=rollback |

---

## MV-10: Offline Guarantee

Automated coverage: `unit_tests/security/offlineEnforcement.test.ts`,
`integration_tests/security/offline_guard.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | `docker compose up` | `network_mode: none`; container has no network |
| 2 | `docker compose run --rm test` | All unit + integration pass; `OFFLINE CHECK` reports egress blocked |
| 3 | Open renderer DevTools, run `fetch('https://example.com')` | Promise rejects; main process logs `network_blocked` |
| 4 | Attempt `new Image().src = 'https://evil.com/x.gif'` | Request cancelled |

---

## MV-11: Admin Tenant Onboarding

Automated coverage: `unit_tests/ipc/createTenant.test.ts`,
`unit_tests/imgui/adminTenantForm.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Sign in as SystemAdmin (from `initial-credentials.txt`) | Admin view shows a **Tenants** section above Users |
| 2 | Click Tenants table | Lists the default tenant with id / name / created-at |
| 3 | Fill the "Create tenant" form with valid values | Banner: `Tenant created: <id>`; table gains a new row |
| 4 | Submit with tenant id `BAD!` | Form banner: `tenant id must be 2–48 chars of [a-z0-9_-]` |
| 5 | Submit with 5-char password | Banner: `admin password must be ≥ 8 chars` |
| 6 | Sign in as a TenantAdmin (not SystemAdmin) | Tenants section + Create form hidden |

---

## MV-12: Dashboard Filters + Hottest Seats

Automated coverage: `unit_tests/imgui/dashboardFilters.test.ts`,
`unit_tests/analytics/hotSeatRooms.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open Dashboard | Filters row with `storeId / from / to / hourOfDay` |
| 2 | Enter store id + click Apply filters | KPIs + hot slots + hot seats reflect the filtered window |
| 3 | Enter `hourOfDay=14` | Orders/revenue numbers reduce; hot slots narrow |
| 4 | Press Ctrl+E | Save dialog opens; the produced CSV contains a `hot_seat_room_id,...` section under the filter header |
| 5 | Click Clear | Filters empty; numbers return to last-24h defaults |

---

## MV-13: Reviews — Attachments + Follow-up + Override

Automated coverage: `unit_tests/reviews/assets.test.ts`,
`unit_tests/ipc/reviewsFollowUpSla.test.ts`,
`unit_tests/imgui/reviewsForm.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open Reviews → fill body → click Attach images | OS file picker; pick 2 JPGs + 1 PNG |
| 2 | Click Submit review | Banner `Review submitted`; moderation queue updated |
| 3 | Try to attach a 6th image | Picker returns `too_many_selected` |
| 4 | Select a review with `follow_up_due_at` in the future | Follow-up section visible; submit a follow-up review |
| 5 | Pick a review where `reply_due_at < now`, sign in as OperationsManager | SLA banner red; Reply button disabled/blocked with `reply_sla_expired` |
| 6 | Sign in as TenantAdmin | Late-reply override toggle appears; reason field required |
| 7 | Submit with override + reason | Banner: `Reply posted with admin override (audited)`; chain event `review.reply_late_override` produced |

---

## MV-14: Routing 2–25 Dynamic Stops

Automated coverage: `unit_tests/imgui/routingStops.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open Routing → default 2 stops visible | Cannot remove below 2 (`−` button hidden on both rows) |
| 2 | Click `+ Add stop` 23 times | Total 25 rows; button disappears at the cap |
| 3 | Try to add a 26th | Add button gone — client-side clamp matches backend bound |
| 4 | Leave a blank row between entries | `validateStopCount` ignores blanks; `filled` count drives pass/fail |
| 5 | Click Plan route with only one non-blank stop | Banner: `Enter at least 2 addresses (got 1)` |

---

## MV-15: Configurable Shortcuts

Automated coverage: `unit_tests/shortcuts/config.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open palette (Ctrl+K) → choose "Settings" | Settings view shows all defaults with accelerators |
| 2 | Change `export` to `Ctrl+Alt+E` → Save | Status shows custom badge; menu accelerator updates immediately |
| 3 | Inspect `userData/shortcuts.json` | File exists with `{ "version": 1, "overrides": { "export": "Ctrl+Alt+E" } }` |
| 4 | Set `search` to `Ctrl+E` (conflicts with export) | Save rejected: `shortcut_config:accelerator_conflict` |
| 5 | Click Restore default on `export` | File's overrides object loses the `export` key |
| 6 | Click Reset all | File contains `{ "version": 1, "overrides": {} }`; menu returns to defaults |

---

## MV-16: Context Menus Across Views

Automated coverage: `unit_tests/imgui/contextMenu.test.ts`,
`unit_tests/imgui/contextMenuCoverage.test.ts`.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Right-click a row in **Contracts** | Menu: Approve / Reject / Edit / Copy row |
| 2 | Right-click a row in **Reviews** | Menu: Approve / Reject / Copy row |
| 3 | Right-click a row in **Audit** | Menu: Copy hash (full) / Copy row / Copy all visible rows |
| 4 | Right-click a row in **Routing** | Menu: Activate (disabled on active row) / Copy row |
| 5 | Click "Copy row" → paste in Excel | Cells align as TSV, embedded tabs/newlines neutralised |
