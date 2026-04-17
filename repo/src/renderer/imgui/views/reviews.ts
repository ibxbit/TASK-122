import { type ImGuiContext, type Rect } from '../runtime';
import {
  beginWindow, endWindow, heading, text, textDim, separator, spacing,
  button, sameLine, beginTable, tableRow, endTable, banner, menuBar,
  inputText, type InputTextRef,
} from '../widgets';
import { useContextMenu, drawMenu, copyRowAsTsv, cellsToTsv } from '../context-menu';
import type { AppState, IpcBridge } from '../app';

/* =========================================================================
 * Reviews View — submit + moderate + reply + follow-up.
 *
 *  Workflow surfaces:
 *    • Submit a review with optional image attachments (2 → MAX 5 files,
 *      JPG/PNG, ≤5 MiB each).  Attachments flow through files:pickImages
 *      which returns base64 payloads ready for reviews:create.
 *    • Follow-up a prior review within 14 days (reviews:followUp).
 *    • Merchant reply with 7-day SLA; admins can override with a required
 *      reason (reviews:reply).
 *    • Right-click any row for Approve / Reject / Copy.
 * ========================================================================= */

interface ReviewRow {
  id: string; rating: number; title: string | null; body: string;
  targetType: string; targetId: string; status: string;
  moderationStatus: string; flagCount: number; createdAt: number;
  replyDueAt: number | null; followUpDueAt: number | null;
}

interface PickedImage {
  name: string; mimeType: string; sizeBytes: number; base64: string;
}

interface Bucket {
  rows: ReviewRow[];
  flagsCount: number;
  error: string | null;
  loading: boolean; loaded: boolean;

  newTargetType: InputTextRef;
  newTargetId:   InputTextRef;
  newRating:     InputTextRef;
  newTitle:      InputTextRef;
  newBody:       InputTextRef;
  newAttachments: PickedImage[];

  replyBody:     InputTextRef;
  replyOverride: { value: boolean };
  replyOverrideReason: InputTextRef;
  replyTarget: string | null;

  followUpRating: InputTextRef;
  followUpBody:   InputTextRef;

  actionMsg: { text: string; tone: 'ok' | 'warn' | 'fail' } | null;
}

const BUCKET = new WeakMap<AppState, Bucket>();
function bucket(s: AppState): Bucket {
  let b = BUCKET.get(s);
  if (!b) {
    b = {
      rows: [], flagsCount: 0, error: null, loading: false, loaded: false,
      newTargetType: { value: 'order' }, newTargetId: { value: '' },
      newRating: { value: '5' }, newTitle: { value: '' }, newBody: { value: '' },
      newAttachments: [],
      replyBody: { value: '' },
      replyOverride: { value: false },
      replyOverrideReason: { value: '' },
      replyTarget: null,
      followUpRating: { value: '5' }, followUpBody: { value: '' },
      actionMsg: null,
    };
    BUCKET.set(s, b);
  }
  return b;
}

/* ----------------------------------------------------------------
 *  Form validators — exported so unit tests can drive them directly
 *  without mounting the renderer.
 * ---------------------------------------------------------------- */

export interface CreateReviewFormInput {
  targetType: string;
  targetId:   string;
  rating:     string;
  body:       string;
  attachmentCount: number;
}
export function validateCreateReviewForm(f: CreateReviewFormInput): string[] {
  const issues: string[] = [];
  if (!['order', 'contract', 'seat_room', 'other'].includes(f.targetType)) {
    issues.push('targetType must be one of order/contract/seat_room/other');
  }
  if (!f.targetId.trim()) issues.push('targetId required');
  const r = parseInt(f.rating, 10);
  if (!Number.isInteger(r) || r < 1 || r > 5) issues.push('rating must be an integer 1..5');
  if (!f.body.trim()) issues.push('body required');
  if (f.body.length > 2000) issues.push('body too long (max 2000 chars)');
  if (f.attachmentCount > 5) issues.push('max 5 attachments');
  return issues;
}

export interface LateReplyPolicyInput {
  slaMet:         boolean;
  policyOverride: boolean;
  overrideReason: string;
  isAdmin:        boolean;
}
/** UI-side precheck for the late-reply override path.  Mirrors the
 *  main-process rules so the user gets immediate feedback. */
export function lateReplyPolicyError(f: LateReplyPolicyInput): string | null {
  if (f.slaMet) return null;                            // in SLA, no override needed
  if (!f.policyOverride) return 'reply_sla_expired';    // late and no override toggle
  if (!f.overrideReason.trim()) return 'override_reason_required';
  if (!f.isAdmin) return 'override_requires_admin';
  return null;
}

/* ---------------------------------------------------------------- */

async function reload(b: Bucket, bridge: IpcBridge): Promise<void> {
  b.loading = true; b.error = null;
  try {
    const [list, flags] = await Promise.all([
      bridge.invoke('reviews:list', { limit: 100 }) as Promise<ReviewRow[]>,
      bridge.invoke('reviews:flags') as Promise<unknown[]>,
    ]);
    b.rows       = Array.isArray(list) ? list : [];
    b.flagsCount = Array.isArray(flags) ? flags.length : 0;
    b.loaded = true;
  } catch (err) {
    b.error = String((err as Error)?.message ?? err);
  } finally {
    b.loading = false;
  }
}

export function drawReviewsView(
  ctx: ImGuiContext, state: AppState, bridge: IpcBridge,
): void {
  const b = bucket(state);
  if (!b.loaded && !b.loading) void reload(b, bridge);

  // Ctrl+E → export the review rows as TSV via clipboard (there's no
  // server-side review export; clipboard is the quickest deterministic
  // surface).
  if (state.exportRequested) {
    state.exportRequested = false;
    const tsv = cellsToTsv([
      ['id','rating','status','moderation','target','title'],
      ...b.rows.map((r) => [r.id, r.rating, r.status, r.moderationStatus,
                            `${r.targetType}:${r.targetId}`, r.title ?? '']),
    ]);
    void copyRowAsTsv([tsv]).then(() => {
      state.statusMessage = 'Reviews copied to clipboard';
    });
  }

  menuBar(ctx, { x: 0, y: 0, w: ctx.width, h: 24 }, [
    { label: 'Dashboard', onClick: () => { state.kind = 'dashboard'; } },
    { label: 'Contracts', onClick: () => { state.kind = 'contracts'; } },
    { label: 'Audit',     onClick: () => { state.kind = 'audit';     } },
    { label: 'Reviews',   onClick: () => { state.kind = 'reviews';   } },
    { label: 'Routing',   onClick: () => { state.kind = 'routing';   } },
    { label: 'Admin',     onClick: () => { state.kind = 'admin';     } },
  ]);

  const rect: Rect = { x: 0, y: 24, w: ctx.width, h: ctx.height - 24 };
  beginWindow(ctx, 'Reviews', rect);

  if (b.actionMsg) banner(ctx, b.actionMsg.text, b.actionMsg.tone);
  if (b.error)     text(ctx, `Failed: ${b.error}`, ctx.theme.Fail);

  // ── Compose panel ────────────────────────────────────────────────
  heading(ctx, 'Submit a review');
  inputText(ctx, 'Target type', b.newTargetType, { width: 140, placeholder: 'order | contract | seat_room | other' });
  sameLine(ctx);
  inputText(ctx, 'Target id', b.newTargetId, { width: 200 });
  inputText(ctx, 'Rating 1–5', b.newRating, { width: 80 });
  sameLine(ctx);
  inputText(ctx, 'Title', b.newTitle, { width: 260 });
  inputText(ctx, 'Body',  b.newBody, { width: 520 });

  // Attachments
  text(ctx, `Attachments: ${b.newAttachments.length} / 5`);
  sameLine(ctx);
  if (button(ctx, 'Attach images')) {
    void bridge.invoke('files:pickImages').then((r) => {
      const res = r as { ok: boolean; files?: PickedImage[]; error?: string };
      if (!res.ok) { b.actionMsg = { text: `Attach failed: ${res.error}`, tone: 'fail' }; return; }
      // Merge with what's already attached, capped at 5
      const combined = [...b.newAttachments, ...(res.files ?? [])].slice(0, 5);
      b.newAttachments = combined;
      b.actionMsg = { text: `Attached ${res.files?.length ?? 0} image(s)`, tone: 'ok' };
    });
  }
  sameLine(ctx);
  if (button(ctx, 'Clear attachments', 'danger')) b.newAttachments = [];

  if (button(ctx, 'Submit review', 'accent')) {
    const issues = validateCreateReviewForm({
      targetType: b.newTargetType.value,
      targetId:   b.newTargetId.value,
      rating:     b.newRating.value,
      body:       b.newBody.value,
      attachmentCount: b.newAttachments.length,
    });
    if (issues.length) {
      b.actionMsg = { text: `Form: ${issues.join('; ')}`, tone: 'warn' };
    } else {
      void bridge.invoke('reviews:create', {
        targetType: b.newTargetType.value,
        targetId:   b.newTargetId.value,
        rating:     parseInt(b.newRating.value, 10),
        title:      b.newTitle.value || undefined,
        body:       b.newBody.value,
        assets:     b.newAttachments.map((a) => ({
          mimeType: a.mimeType, sizeBytes: a.sizeBytes, base64: a.base64,
        })),
      }).then((res) => {
        const r = res as { ok: boolean; issues?: Array<{ message: string }>; assetFailure?: string | null };
        if (r.ok) {
          const note = r.assetFailure ? ` (asset issue: ${r.assetFailure})` : '';
          b.actionMsg = { text: 'Review submitted' + note,
                          tone: r.assetFailure ? 'warn' : 'ok' };
          b.newBody.value = ''; b.newTitle.value = ''; b.newTargetId.value = '';
          b.newAttachments = [];
          return reload(b, bridge);
        }
        b.actionMsg = { text: `Validation: ${(r.issues ?? []).map((i) => i.message).join('; ')}`, tone: 'warn' };
        return undefined;
      }).catch((err) => {
        b.actionMsg = { text: `Submit failed: ${String(err)}`, tone: 'fail' };
      });
    }
  }

  separator(ctx);
  heading(ctx, `Moderation queue — ${b.flagsCount} pending`);

  const tbl = beginTable(ctx, 'reviews', [
    { key: 'target', header: 'Target', width: 220 },
    { key: 'rate',   header: 'Rating', width: 70 },
    { key: 'mod',    header: 'Moderation', width: 120 },
    { key: 'flags',  header: 'Flags', width: 70 },
    { key: 'title',  header: 'Title' },
  ]);

  const rowMenu = useContextMenu(ctx, 'reviews-row-menu');
  let menuRow: ReviewRow | null = null;

  if (tbl) {
    for (const r of b.rows) {
      const row = tableRow(ctx, tbl, [
        `${r.targetType}:${r.targetId}`,
        r.rating,
        r.moderationStatus,
        r.flagCount,
        r.title ?? r.body.slice(0, 40),
      ]);
      if (row.clicked) b.replyTarget = r.id;
      if (row.hovered && ctx.input.rightPressed) {
        rowMenu.open(ctx.input.mouseX, ctx.input.mouseY);
        menuRow = r;
        b.replyTarget = r.id;
      }
    }
    endTable(ctx, tbl);
  }

  if (menuRow || rowMenu.isOpen) {
    const row = menuRow ?? b.rows.find((r) => r.id === b.replyTarget) ?? null;
    if (row) {
      drawMenu(ctx, rowMenu, [
        { label: 'Approve', tone: 'accent',
          onClick: () => {
            void bridge.invoke('reviews:moderate', { id: row.id, decision: 'approve' })
              .then(() => { b.actionMsg = { text: `Approved ${row.id}`, tone: 'ok' }; return reload(b, bridge); })
              .catch((e) => { b.actionMsg = { text: `Approve failed: ${String(e)}`, tone: 'fail' }; });
          } },
        { label: 'Reject',  tone: 'danger',
          onClick: () => {
            void bridge.invoke('reviews:moderate', { id: row.id, decision: 'reject' })
              .then(() => { b.actionMsg = { text: `Rejected ${row.id}`, tone: 'warn' }; return reload(b, bridge); })
              .catch((e) => { b.actionMsg = { text: `Reject failed: ${String(e)}`, tone: 'fail' }; });
          } },
        { type: 'separator' },
        { label: 'Copy row', accelerator: 'Ctrl+C',
          onClick: () => {
            void copyRowAsTsv([
              row.id, row.rating, row.status, row.moderationStatus,
              `${row.targetType}:${row.targetId}`, row.title ?? '',
            ]).then((ok) => {
              b.actionMsg = ok
                ? { text: 'Row copied', tone: 'ok' }
                : { text: 'Copy failed', tone: 'fail' };
            });
          } },
      ]);
    }
  }

  separator(ctx);
  if (b.replyTarget) {
    const target = b.rows.find((r) => r.id === b.replyTarget);
    const isAdmin = state.sessionRoles.includes('TenantAdmin') || state.sessionRoles.includes('SystemAdmin');
    const now = Math.floor(Date.now() / 1000);
    const slaMet = !target || target.replyDueAt === null || now <= target.replyDueAt;
    const followUpOpen = target?.followUpDueAt !== null && (target?.followUpDueAt ?? 0) >= now;

    heading(ctx, `Actions on ${b.replyTarget}`);
    if (!slaMet) {
      banner(ctx, `Reply SLA has expired. ${isAdmin ? 'Admin override available.' : 'Only admins can override.'}`, 'warn');
    }

    // Reply form
    inputText(ctx, 'Reply body', b.replyBody, { width: 520 });
    if (!slaMet && isAdmin) {
      // Toggle-style override checkbox represented as a button that flips
      // the boolean (we have a checkbox widget but keep UI compact).
      if (button(ctx, b.replyOverride.value ? '✔ Policy override ON' : 'Override SLA (admin)')) {
        b.replyOverride.value = !b.replyOverride.value;
      }
      if (b.replyOverride.value) {
        inputText(ctx, 'Override reason', b.replyOverrideReason, { width: 520, placeholder: 'required' });
      }
    }
    if (button(ctx, 'Reply', 'accent')) {
      const err = lateReplyPolicyError({
        slaMet, policyOverride: b.replyOverride.value,
        overrideReason: b.replyOverrideReason.value,
        isAdmin,
      });
      if (err) {
        b.actionMsg = { text: `Reply blocked: ${err}`, tone: 'warn' };
      } else {
        const payload: Record<string, unknown> = { reviewId: b.replyTarget, body: b.replyBody.value };
        if (!slaMet) {
          payload.policyOverride = true;
          payload.overrideReason = b.replyOverrideReason.value.trim();
        }
        void bridge.invoke('reviews:reply', payload)
          .then((r) => {
            const res = r as { ok: boolean; error?: string; withinSla?: boolean; override?: boolean };
            if (!res.ok) { b.actionMsg = { text: `Reply failed: ${res.error}`, tone: 'fail' }; return; }
            b.actionMsg = {
              text: res.override ? 'Reply posted with admin override (audited)'
                                 : 'Reply posted',
              tone: res.override ? 'warn' : 'ok',
            };
            b.replyBody.value = ''; b.replyOverride.value = false; b.replyOverrideReason.value = '';
          })
          .catch((e) => { b.actionMsg = { text: `Reply failed: ${String(e)}`, tone: 'fail' }; });
      }
    }

    sameLine(ctx);
    if (button(ctx, 'Approve')) {
      if (!target) return;
      void bridge.invoke('reviews:moderate', { id: b.replyTarget, decision: 'approve' })
        .then(() => reload(b, bridge))
        .catch((err) => { b.actionMsg = { text: `Moderate failed: ${String(err)}`, tone: 'fail' }; });
    }
    sameLine(ctx);
    if (button(ctx, 'Reject', 'danger')) {
      void bridge.invoke('reviews:moderate', { id: b.replyTarget, decision: 'reject' })
        .then(() => reload(b, bridge))
        .catch((err) => { b.actionMsg = { text: `Moderate failed: ${String(err)}`, tone: 'fail' }; });
    }
    sameLine(ctx);
    if (button(ctx, 'Close follow-up')) {
      void bridge.invoke('reviews:resolveFollowUp', { id: b.replyTarget })
        .then(() => reload(b, bridge))
        .catch((err) => { b.actionMsg = { text: `Close failed: ${String(err)}`, tone: 'fail' }; });
    }

    // ── Follow-up form (14-day window) ─────────────────────────────
    separator(ctx);
    heading(ctx, 'Follow-up review (within 14 days)');
    if (!followUpOpen) {
      textDim(ctx, 'Follow-up window closed on this review.');
    } else {
      inputText(ctx, 'Rating 1–5', b.followUpRating, { width: 80 });
      sameLine(ctx);
      inputText(ctx, 'Follow-up body', b.followUpBody, { width: 520 });
      if (button(ctx, 'Submit follow-up', 'accent')) {
        const r = parseInt(b.followUpRating.value, 10);
        if (!Number.isInteger(r) || r < 1 || r > 5) {
          b.actionMsg = { text: 'Follow-up rating must be 1..5', tone: 'warn' };
        } else if (!b.followUpBody.value.trim()) {
          b.actionMsg = { text: 'Follow-up body required', tone: 'warn' };
        } else {
          void bridge.invoke('reviews:followUp', {
            parentReviewId: b.replyTarget,
            rating:         r,
            body:           b.followUpBody.value,
          }).then((raw) => {
            const res = raw as { ok: boolean; id?: string; error?: string };
            if (res.ok) {
              b.actionMsg = { text: `Follow-up submitted (${res.id})`, tone: 'ok' };
              b.followUpBody.value = '';
              return reload(b, bridge);
            }
            b.actionMsg = { text: `Follow-up failed: ${res.error}`, tone: 'fail' };
            return undefined;
          }).catch((err) => { b.actionMsg = { text: `Follow-up failed: ${String(err)}`, tone: 'fail' }; });
        }
      }
    }
  } else {
    textDim(ctx, 'Click a review to open reply / follow-up / moderation actions.');
  }

  endWindow(ctx);
}
