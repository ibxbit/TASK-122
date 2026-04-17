import { type ImGuiContext, type Rect } from '../runtime';
import {
  beginWindow, endWindow, heading, text, textDim, separator, spacing,
  button, sameLine, beginTable, tableRow, endTable, banner, menuBar,
  inputText, type InputTextRef,
} from '../widgets';
import type { AppState, IpcBridge } from '../app';

/* =========================================================================
 * Admin View — tenant / users / roles / policies / updates.
 * ========================================================================= */

interface UserRow { id: string; username: string; displayName: string; status: string; }
interface PolicyRow { id: string; word: string; severity: string; category: string | null; }
interface VersionEntry { version: string; installedAt: string; issuer: string; installedBy?: string; }
interface TenantRow { id: string; name: string; createdAt: number; }

interface Bucket {
  users: UserRow[];
  policies: PolicyRow[];
  versions: VersionEntry[];
  tenants: TenantRow[];
  loading: boolean; loaded: boolean; error: string | null;

  // Tenant onboarding form (SystemAdmin only)
  newTenantId:       InputTextRef;
  newTenantName:     InputTextRef;
  newTenantAdminUser:  InputTextRef;
  newTenantAdminDisplay: InputTextRef;
  newTenantAdminPassword: InputTextRef;

  newUsername:    InputTextRef;
  newDisplayName: InputTextRef;
  newPassword:    InputTextRef;

  grantUserId:    InputTextRef;
  grantRoleCode:  InputTextRef;

  newWord:    InputTextRef;
  newSeverity: InputTextRef;

  pkgPath:       InputTextRef;
  rollbackVer:   InputTextRef;

  actionMsg: { text: string; tone: 'ok' | 'warn' | 'fail' } | null;
}

const BUCKET = new WeakMap<AppState, Bucket>();
function bucket(s: AppState): Bucket {
  let b = BUCKET.get(s);
  if (!b) {
    b = {
      users: [], policies: [], versions: [], tenants: [],
      loading: false, loaded: false, error: null,
      newTenantId:   { value: '' },
      newTenantName: { value: '' },
      newTenantAdminUser:     { value: '' },
      newTenantAdminDisplay:  { value: '' },
      newTenantAdminPassword: { value: '' },
      newUsername:    { value: '' },
      newDisplayName: { value: '' },
      newPassword:    { value: '' },
      grantUserId:    { value: '' },
      grantRoleCode:  { value: 'OperationsManager' },
      newWord:        { value: '' },
      newSeverity:    { value: 'flag' },
      pkgPath:        { value: '' },
      rollbackVer:    { value: '' },
      actionMsg: null,
    };
    BUCKET.set(s, b);
  }
  return b;
}

async function reload(b: Bucket, bridge: IpcBridge, roles: string[]): Promise<void> {
  b.loading = true; b.error = null;
  try {
    const calls: Array<Promise<unknown>> = [
      bridge.invoke('admin:listUsers').catch(() => []),
      bridge.invoke('admin:policies').catch(() => []),
      bridge.invoke('updates:versions').catch(() => []),
    ];
    // Tenant list is only available to SystemAdmins — call it only for
    // those roles so non-admin testers don't get a spurious denial error.
    if (roles.includes('SystemAdmin')) {
      calls.push(bridge.invoke('admin:listTenants').catch(() => []));
    } else {
      calls.push(Promise.resolve([]));
    }
    const [users, policies, versions, tenants] = await Promise.all(calls);
    b.users    = Array.isArray(users)    ? users as UserRow[]      : [];
    b.policies = Array.isArray(policies) ? policies as PolicyRow[] : [];
    b.versions = Array.isArray(versions) ? versions as VersionEntry[] : [];
    b.tenants  = Array.isArray(tenants)  ? tenants as TenantRow[]  : [];
    b.loaded   = true;
  } catch (err) {
    b.error = String((err as Error)?.message ?? err);
  } finally {
    b.loading = false;
  }
}

/** Exported for unit tests — validates an admin tenant-create form.
 *  Returns the list of validation issues the UI should show, empty on ok. */
export interface CreateTenantFormInput {
  tenantId:         string;
  name:             string;
  adminUsername:    string;
  adminDisplayName: string;
  adminPassword:    string;
}
export function validateCreateTenantForm(f: CreateTenantFormInput): string[] {
  const issues: string[] = [];
  if (!f.tenantId.trim()) issues.push('tenant id required');
  else if (!/^[a-z0-9_][a-z0-9_\-]{1,47}$/.test(f.tenantId.trim())) {
    issues.push('tenant id must be 2–48 chars of [a-z0-9_-]');
  }
  if (!f.name.trim())            issues.push('name required');
  if (!f.adminUsername.trim())   issues.push('admin username required');
  if (!f.adminDisplayName.trim()) issues.push('admin display name required');
  if (f.adminPassword.length < 8) issues.push('admin password must be ≥ 8 chars');
  return issues;
}

export function drawAdminView(
  ctx: ImGuiContext, state: AppState, bridge: IpcBridge,
): void {
  const b = bucket(state);
  if (!b.loaded && !b.loading) void reload(b, bridge, state.sessionRoles);

  menuBar(ctx, { x: 0, y: 0, w: ctx.width, h: 24 }, [
    { label: 'Dashboard', onClick: () => { state.kind = 'dashboard'; } },
    { label: 'Contracts', onClick: () => { state.kind = 'contracts'; } },
    { label: 'Audit',     onClick: () => { state.kind = 'audit';     } },
    { label: 'Reviews',   onClick: () => { state.kind = 'reviews';   } },
    { label: 'Routing',   onClick: () => { state.kind = 'routing';   } },
    { label: 'Admin',     onClick: () => { state.kind = 'admin';     } },
  ]);

  const rect: Rect = { x: 0, y: 24, w: ctx.width, h: ctx.height - 24 };
  beginWindow(ctx, 'Admin Console', rect);

  if (!state.sessionRoles.includes('TenantAdmin') && !state.sessionRoles.includes('SystemAdmin')) {
    banner(ctx, 'Admin privileges required — showing read-only summary.', 'warn');
  }
  if (b.actionMsg) banner(ctx, b.actionMsg.text, b.actionMsg.tone);
  if (b.error)     text(ctx, `Failed: ${b.error}`, ctx.theme.Fail);

  // ── Tenants (SystemAdmin only) ────────────────────────────────────
  if (state.sessionRoles.includes('SystemAdmin')) {
    heading(ctx, `Tenants — ${b.tenants.length}`);
    const tt = beginTable(ctx, 'tenants', [
      { key: 'id',   header: 'Id',         width: 180 },
      { key: 'name', header: 'Name',       width: 260 },
      { key: 'at',   header: 'Created at' },
    ]);
    if (tt) {
      for (const t of b.tenants) {
        tableRow(ctx, tt, [
          t.id, t.name,
          new Date(t.createdAt * 1000).toISOString().slice(0, 10),
        ]);
      }
      endTable(ctx, tt);
    }

    heading(ctx, 'Create tenant');
    inputText(ctx, 'Tenant id', b.newTenantId,   { width: 220, placeholder: 'e.g. t_beta' });
    sameLine(ctx);
    inputText(ctx, 'Name',      b.newTenantName, { width: 260 });
    inputText(ctx, 'Admin user',      b.newTenantAdminUser,     { width: 220 });
    sameLine(ctx);
    inputText(ctx, 'Admin display',   b.newTenantAdminDisplay,  { width: 260 });
    sameLine(ctx);
    inputText(ctx, 'Admin password',  b.newTenantAdminPassword, { width: 220, password: true });
    if (button(ctx, 'Create tenant', 'accent')) {
      const issues = validateCreateTenantForm({
        tenantId:        b.newTenantId.value,
        name:            b.newTenantName.value,
        adminUsername:   b.newTenantAdminUser.value,
        adminDisplayName: b.newTenantAdminDisplay.value,
        adminPassword:   b.newTenantAdminPassword.value,
      });
      if (issues.length) {
        b.actionMsg = { text: `Form: ${issues.join('; ')}`, tone: 'warn' };
      } else {
        void bridge.invoke('admin:createTenant', {
          tenantId: b.newTenantId.value.trim(),
          name:     b.newTenantName.value.trim(),
          initialAdmin: {
            username:    b.newTenantAdminUser.value.trim(),
            displayName: b.newTenantAdminDisplay.value.trim(),
            password:    b.newTenantAdminPassword.value,
          },
        }).then((r) => {
          const res = r as { ok: boolean; tenantId?: string; error?: string };
          b.actionMsg = res.ok
            ? { text: `Tenant created: ${res.tenantId}`, tone: 'ok' }
            : { text: `Create tenant failed: ${res.error}`, tone: 'fail' };
          if (res.ok) {
            b.newTenantId.value = ''; b.newTenantName.value = '';
            b.newTenantAdminUser.value = '';
            b.newTenantAdminDisplay.value = '';
            b.newTenantAdminPassword.value = '';
            void reload(b, bridge, state.sessionRoles);
          }
        }).catch((err) => {
          b.actionMsg = { text: `Create tenant failed: ${String(err)}`, tone: 'fail' };
        });
      }
    }
    separator(ctx);
  }

  // ── Users ─────────────────────────────────────────────────────────
  heading(ctx, `Users — ${b.users.length}`);
  inputText(ctx, 'Username',    b.newUsername,    { width: 180 });
  sameLine(ctx);
  inputText(ctx, 'Display',     b.newDisplayName, { width: 220 });
  sameLine(ctx);
  inputText(ctx, 'Password',    b.newPassword,    { width: 180, password: true });
  if (button(ctx, 'Create user', 'accent')) {
    void bridge.invoke('admin:createUser', {
      username: b.newUsername.value,
      displayName: b.newDisplayName.value,
      password: b.newPassword.value,
      verified: true,
    }).then((r) => {
      const res = r as { ok: boolean; error?: string; userId?: string };
      b.actionMsg = res.ok
        ? { text: `User created: ${res.userId}`, tone: 'ok' }
        : { text: `Create failed: ${res.error}`, tone: 'fail' };
      if (res.ok) {
        b.newUsername.value = ''; b.newDisplayName.value = ''; b.newPassword.value = '';
        void reload(b, bridge, state.sessionRoles);
      }
    }).catch((err) => { b.actionMsg = { text: `Create failed: ${String(err)}`, tone: 'fail' }; });
  }

  const ut = beginTable(ctx, 'users', [
    { key: 'user',   header: 'Username', width: 160 },
    { key: 'disp',   header: 'Display',  width: 220 },
    { key: 'status', header: 'Status',   width: 100 },
    { key: 'id',     header: 'Id' },
  ]);
  if (ut) {
    for (const u of b.users) {
      tableRow(ctx, ut, [u.username, u.displayName, u.status, u.id]);
    }
    endTable(ctx, ut);
  }

  separator(ctx);
  heading(ctx, 'Grant role');
  inputText(ctx, 'User id',   b.grantUserId,   { width: 260 });
  sameLine(ctx);
  inputText(ctx, 'Role code', b.grantRoleCode, { width: 200 });
  if (button(ctx, 'Grant')) {
    void bridge.invoke('admin:grantRole', {
      userId:   b.grantUserId.value,
      roleCode: b.grantRoleCode.value,
    }).then((r) => {
      const res = r as { ok: boolean; error?: string };
      b.actionMsg = res.ok
        ? { text: 'Role granted', tone: 'ok' }
        : { text: `Grant failed: ${res.error}`, tone: 'fail' };
    }).catch((err) => { b.actionMsg = { text: `Grant failed: ${String(err)}`, tone: 'fail' }; });
  }

  separator(ctx);
  // ── Policies ──────────────────────────────────────────────────────
  heading(ctx, `Moderation dictionary — ${b.policies.length}`);
  inputText(ctx, 'Word',     b.newWord,     { width: 200 });
  sameLine(ctx);
  inputText(ctx, 'Severity', b.newSeverity, { width: 100 });
  if (button(ctx, 'Add', 'accent')) {
    void bridge.invoke('admin:addPolicyWord', {
      word:     b.newWord.value,
      severity: b.newSeverity.value,
    }).then((r) => {
      const res = r as { ok: boolean; error?: string };
      b.actionMsg = res.ok
        ? { text: 'Word added', tone: 'ok' }
        : { text: `Add failed: ${res.error}`, tone: 'fail' };
      if (res.ok) { b.newWord.value = ''; void reload(b, bridge, state.sessionRoles); }
    }).catch((err) => { b.actionMsg = { text: `Add failed: ${String(err)}`, tone: 'fail' }; });
  }

  const pt = beginTable(ctx, 'policies', [
    { key: 'word',     header: 'Word',     width: 200 },
    { key: 'severity', header: 'Severity', width: 100 },
    { key: 'cat',      header: 'Category' },
  ]);
  if (pt) {
    for (const p of b.policies) {
      tableRow(ctx, pt, [p.word, p.severity, p.category ?? '—']);
    }
    endTable(ctx, pt);
  }

  separator(ctx);
  // ── Updates ───────────────────────────────────────────────────────
  heading(ctx, `Installed versions — ${b.versions.length}`);
  inputText(ctx, 'Package path',    b.pkgPath,     { width: 520 });
  if (button(ctx, 'Import update', 'accent')) {
    void bridge.invoke('updates:import', { packagePath: b.pkgPath.value })
      .then(() => { b.actionMsg = { text: 'Update staged', tone: 'ok' }; b.pkgPath.value = ''; return reload(b, bridge, state.sessionRoles); })
      .catch((err) => { b.actionMsg = { text: `Import failed: ${String(err)}`, tone: 'fail' }; });
  }
  inputText(ctx, 'Rollback to version', b.rollbackVer, { width: 200 });
  sameLine(ctx);
  if (button(ctx, 'Queue rollback', 'danger')) {
    void bridge.invoke('updates:rollback', { targetVersion: b.rollbackVer.value })
      .then(() => { b.actionMsg = { text: 'Rollback queued', tone: 'warn' }; return reload(b, bridge, state.sessionRoles); })
      .catch((err) => { b.actionMsg = { text: `Rollback failed: ${String(err)}`, tone: 'fail' }; });
  }
  sameLine(ctx);
  if (button(ctx, 'Cancel pending')) {
    void bridge.invoke('updates:cancel')
      .then(() => { b.actionMsg = { text: 'Pending cancelled', tone: 'ok' }; return reload(b, bridge, state.sessionRoles); })
      .catch((err) => { b.actionMsg = { text: `Cancel failed: ${String(err)}`, tone: 'fail' }; });
  }

  const vt = beginTable(ctx, 'versions', [
    { key: 'ver',    header: 'Version',      width: 140 },
    { key: 'issuer', header: 'Issuer',       width: 180 },
    { key: 'at',     header: 'Installed' },
  ]);
  if (vt) {
    for (const v of b.versions) {
      tableRow(ctx, vt, [v.version, v.issuer, v.installedAt]);
    }
    endTable(ctx, vt);
  }

  endWindow(ctx);
}
