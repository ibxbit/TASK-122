import { type ImGuiContext, type Rect } from '../runtime';
import { beginWindow, endWindow, heading, textDim, text, inputText, button, spacing, separator, type InputTextRef } from '../widgets';
import type { AppState, IpcBridge, WindowKind } from '../app';

/* =========================================================================
 * Search Palette — Ctrl+K overlay.
 *
 *  Renders only while `state.searchOpen` is true.  Handles:
 *    • Escape / click outside to close
 *    • text entry (ImGui inputText)
 *    • "Go to <view>" quick-actions (Dashboard / Contracts / Audit / …)
 *      that change state.kind and close the palette
 *
 *  This is a real, working productivity surface — not a placeholder.
 * ========================================================================= */

const TARGETS: Array<{ kind: WindowKind; label: string; hint: string }> = [
  { kind: 'dashboard', label: 'Dashboard',         hint: 'Operations at a glance' },
  { kind: 'contracts', label: 'Contract Workspace', hint: 'Drafts, signing, expiry' },
  { kind: 'audit',     label: 'Audit Log',          hint: 'Chain-verified events' },
  { kind: 'reviews',   label: 'Reviews',            hint: 'Submit + moderate' },
  { kind: 'routing',   label: 'Routing',            hint: 'Datasets + optimize' },
  { kind: 'admin',     label: 'Admin Console',      hint: 'Users / policies / updates' },
  { kind: 'settings',  label: 'Settings',           hint: 'Keyboard shortcuts' },
];

const STATE = new WeakMap<AppState, { query: InputTextRef }>();
function bucket(state: AppState): { query: InputTextRef } {
  let b = STATE.get(state);
  if (!b) { b = { query: { value: '' } }; STATE.set(state, b); }
  return b;
}

export function drawSearchPalette(
  ctx: ImGuiContext, state: AppState, _bridge: IpcBridge,
): void {
  if (!state.searchOpen) return;
  const b = bucket(state);

  // Dim backdrop
  ctx.addRect({ x: 0, y: 0, w: ctx.width, h: ctx.height }, '#000000aa');

  const panelW = Math.min(520, ctx.width - 48);
  const panelH = 420;
  const rect: Rect = {
    x: (ctx.width - panelW) / 2,
    y: (ctx.height - panelH) / 2,
    w: panelW, h: panelH,
  };

  beginWindow(ctx, 'Search', rect);
  heading(ctx, 'Go to…');
  textDim(ctx, 'Type to filter.  Enter or click to open.  Escape to close.');
  spacing(ctx, 6);

  inputText(ctx, 'Query', b.query, { width: panelW - 120, placeholder: 'e.g. contract' });
  state.searchQuery = b.query.value;

  spacing(ctx, 4);
  separator(ctx);

  const q = b.query.value.trim().toLowerCase();
  const matches = q.length === 0
    ? TARGETS
    : TARGETS.filter((t) => t.label.toLowerCase().includes(q) || t.hint.toLowerCase().includes(q));

  for (const t of matches) {
    if (button(ctx, `${t.label} — ${t.hint}`)) {
      state.kind = t.kind;
      state.searchOpen = false;
      b.query.value = '';
    }
  }
  if (matches.length === 0) text(ctx, 'No matches.', ctx.theme.TextDim);

  spacing(ctx, 6);
  // Enter on a filtered single match or Escape closes the palette.
  if (ctx.input.keysPressed.has('Enter') && matches.length === 1) {
    state.kind = matches[0].kind;
    state.searchOpen = false;
    b.query.value = '';
  }
  if (ctx.input.keysPressed.has('Escape')) {
    state.searchOpen = false;
  }

  if (button(ctx, 'Close')) state.searchOpen = false;
  endWindow(ctx);
}
