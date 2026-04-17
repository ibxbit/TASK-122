# Design Overview — LeaseHub Operations Console

## 1. Architecture
- **Desktop App:** Fully offline, Windows 11, English UI, high-DPI, multi-window (dashboard, contract workspace, audit log viewer).
- **UI Layer:** Dear ImGui (per prompt, but see codebase for actual stack), keyboard-first, context menus, tray mode, deep clipboard.
- **Persistence:** SQLite (local file), append-only audit/event log, local asset storage.
- **IPC Layer:** All APIs exposed via IPC or direct function calls (no network).

## 2. User Roles & Workflows
- **System Administrator:** Tenant creation, security policy, user/role management.
- **Tenant Admin:** Location/portfolio management, contract oversight.
- **Operations Manager:** Daily dashboard, occupancy, orders, scheduled reports.
- **Compliance Auditor:** Read-only audit, search/export, hash chain verification.
- **Content Moderator:** Review moderation, anti-fraud, sensitive word policy.

## 3. Key Features
- **Multi-window:** Dashboard, contract workspace, audit log can be open simultaneously.
- **Keyboard-first:** Configurable shortcuts (Ctrl+K, Ctrl+E, Ctrl+Shift+L), right-click context menus.
- **Tray Mode:** Minimize to tray, keep scheduled jobs running, tray notifications/badges.
- **Analytics:** Orders, revenue, occupancy, hot slots, cancellation/repurchase rates, CSV/PDF export.
- **Reviews:** 1–5 stars, 2,000 chars, 5 images (JPG/PNG, 5MB), follow-ups, merchant replies, moderation, anti-fraud.
- **Contracts:** Template-driven, versioned, PDF archive, offline identity verification, admin-verified signers.
- **Audit:** Append-only, SHA-256 hash chain, 7-year retention, tamper-evident, export signed bundles.
- **Route Planning:** Offline, up to 25 stops, local dataset import, detour/restriction rules, rollback.
- **Performance:** <3s cold start, <300MB RAM, crash recovery, 60s checkpoints, offline update/rollback.

## 4. Data Model (Summary)
- **Tenant, OrgUnit, User, Role, Permission, DataScope, Order, Seat/Room, OccupancySnapshot, Review, ReviewAsset, ContractTemplate, ContractInstance, AuditEvent, RouteDataset**
- **Relationships:**
  - Tenant → OrgUnit → User/Role/Permission
  - Order → Seat/Room, OccupancySnapshot
  - Review → ReviewAsset
  - ContractTemplate → ContractInstance
  - AuditEvent (per tenant)
  - RouteDataset (versioned)

## 5. Security & Compliance
- **RBAC/ABAC:** All APIs and UI actions gated by role and data scope.
- **Audit:** Append-only, hash chain, 7-year retention, exportable bundles.
- **Offline:** No network, no external auth, no cloud APIs.

## 6. Extensibility & Maintainability
- **Modular codebase:** Clear separation of modules (access, reviews, contracts, audit, analytics, routing, tray, updates).
- **Testability:** Extensive unit/integration tests, manual verification for UI/UX.
- **Documentation:** README, UI_ARCHITECTURE.md, MANUAL_VERIFICATION.md, API spec, and this design doc.
