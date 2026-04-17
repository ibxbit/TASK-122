# Questions and Business Gaps — LeaseHub Operations Console

## 1. How to handle expired matches?
- **Question:** How should the system handle expired matches (e.g., pending orders, reservations, or review follow-ups)?
- **Hypothesis:** Auto-cancel after 3 minutes per prompt.
- **Solution:** Implemented background cleanup logic that automatically cancels expired matches after 3 minutes of inactivity, as specified in the requirements.

## 2. How to enforce offline-only operation?
- **Question:** What prevents the app from making network calls or using external services?
- **Hypothesis:** All network APIs are stubbed or omitted; no third-party SDKs included.
- **Solution:** Static code review confirms no network dependencies; all data access is local to SQLite and the file system.

## 3. How to ensure 7-year audit retention and tamper-evidence?
- **Question:** How is the 7-year audit log retention and hash chain enforced?
- **Hypothesis:** AuditEvent table uses append-only writes and SHA-256 hash chaining per tenant.
- **Solution:** Schema and code enforce append-only audit, with scheduled cleanup for >7-year-old events and hash chain verification for tamper-evidence.

## 4. How are multi-window workflows and tray mode managed?
- **Question:** How does the app support multi-window dashboards, contract workspaces, and tray mode?
- **Hypothesis:** Electron/ImGui window manager supports multiple independent windows and tray minimization.
- **Solution:** Window manager and tray modules allow users to open, minimize, and restore multiple windows, with scheduled reports running in tray mode.

## 5. How are review moderation and anti-fraud rules enforced?
- **Question:** How does the system prevent review spam and enforce moderation?
- **Hypothesis:** Sensitive-word dictionary and anti-fraud rules are configurable and enforced in review logic.
- **Solution:** Review module applies dictionary and rate/dupe checks; flagged/quarantined reviews require moderator action.

## 6. How is offline route planning achieved?
- **Question:** How does the app support route planning without external map services?
- **Hypothesis:** Road network data is imported from USB and stored locally.
- **Solution:** Route engine uses local dataset for optimization, with versioned detour/restriction rules and no network calls.
