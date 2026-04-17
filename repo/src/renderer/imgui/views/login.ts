import { type ImGuiContext } from '../runtime';
import { beginWindow, endWindow, heading, textDim, inputText, button, spacing, banner, type InputTextRef } from '../widgets';
import type { AppState, IpcBridge } from '../app';

/* =========================================================================
 * Login View — the only non-guarded surface.  Captures credentials and
 * invokes session:login; on success, transitions state → dashboard.
 * ========================================================================= */

interface LoginState {
  tenantId: InputTextRef;
  username: InputTextRef;
  password: InputTextRef;
  pending:  boolean;
  error:    string | null;
}

const BUCKET = new WeakMap<AppState, LoginState>();

function bucket(state: AppState): LoginState {
  let b = BUCKET.get(state);
  if (!b) {
    b = {
      tenantId: { value: '' },
      username: { value: '' },
      password: { value: '' },
      pending:  false,
      error:    null,
    };
    BUCKET.set(state, b);
  }
  return b;
}

export function drawLoginView(
  ctx: ImGuiContext, state: AppState, bridge: IpcBridge,
): void {
  const b = bucket(state);
  const w = ctx.width;
  const h = ctx.height;
  const panelW = 380;
  const panelH = 320;
  const win = beginWindow(ctx, 'LeaseHub — Sign In', {
    x: Math.max(0, (w - panelW) / 2),
    y: Math.max(0, (h - panelH) / 2),
    w: panelW,
    h: panelH,
  });
  void win;

  heading(ctx, 'Sign in to continue');
  textDim(ctx, 'Credentials are verified locally against the offline user store.');
  spacing(ctx, 12);

  inputText(ctx, 'Tenant',    b.tenantId, { width: 240 });
  inputText(ctx, 'User',      b.username, { width: 240 });
  inputText(ctx, 'Password',  b.password, { width: 240, password: true });

  spacing(ctx, 8);

  if (b.error) banner(ctx, b.error, 'fail');

  const label = b.pending ? 'Signing in…' : 'Sign in';
  const clicked = button(ctx, label, 'accent');
  const enterPressed = ctx.input.keysPressed.has('Enter');
  if ((clicked || enterPressed) && !b.pending) {
    b.pending = true;
    b.error   = null;
    void (async () => {
      try {
        const res = await bridge.invoke('session:login', {
          tenantId: b.tenantId.value,
          username: b.username.value,
          password: b.password.value,
        }) as { success: boolean; userId?: string; roles?: string[]; error?: string };
        if (res.success && res.userId) {
          state.sessionUserId   = res.userId;
          state.sessionTenantId = b.tenantId.value;
          state.sessionRoles    = res.roles ?? [];
          state.kind            = 'dashboard';
          state.statusMessage   = `Signed in as ${b.username.value}`;
        } else {
          b.error = `Sign-in failed: ${res.error ?? 'unknown_error'}`;
        }
      } catch (err) {
        b.error = `Sign-in failed: ${String((err as Error)?.message ?? err)}`;
      } finally {
        b.pending = false;
      }
    })();
  }

  endWindow(ctx);
}
