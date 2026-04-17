import { type BrowserWindow } from 'electron';
import type { Database } from 'better-sqlite3';
import { runExpiryScan, type ExpiryNotification, type NotificationSink } from './signing';
import { appendAuditEvent } from '../audit/chain';
import { logger } from '../logger';

/* =========================================================================
 * Expiry Reminder Service
 *
 *  Hosts the NotificationSink wiring for contract expiry reminders.
 *
 *    inApp(notification)  → broadcast 'contracts:expiry_notification' to every
 *                           open renderer so in-app toasts can surface it
 *    tray(notification)   → set tooltip + drive a tray badge helper so the
 *                           user sees something even with all windows hidden
 *
 *  Usage (bootstrap):
 *    const svc = new ExpiryService(db, {
 *      broadcast: (ch, p) => windowManager.broadcast(ch, p),
 *      onTrayBadge: (b) => trayBadgeSetter.setCount(b),
 *    });
 *    scheduler.addJob(svc.createScanJob());
 *
 *  Every notification also appends a 'contract.expiry_notified' audit event
 *  so the reminder chain is tamper-evident.
 * ========================================================================= */

export interface ExpiryServiceDeps {
  /** Send an IPC event to every open renderer. */
  broadcast:   (channel: string, payload: unknown) => void;
  /** Optional tray-badge setter (called with the total pending notification count). */
  onTrayBadge?: (count: number) => void;
}

export class ExpiryService {
  private pendingTrayCount = 0;

  constructor(
    private readonly db: Database,
    private readonly deps: ExpiryServiceDeps,
  ) {}

  /** Run the scan immediately — also used by tests and manual triggers. */
  scanNow(): { fired: number; pendingBadge: number } {
    const fired = runExpiryScan(this.db, this.sink);
    return { fired, pendingBadge: this.pendingTrayCount };
  }

  /** Clear the tray badge (call when the user acknowledges the reminders). */
  clearBadge(): void {
    this.pendingTrayCount = 0;
    this.deps.onTrayBadge?.(0);
  }

  private readonly sink: NotificationSink = {
    inApp: (n) => {
      try {
        this.deps.broadcast('contracts:expiry_notification', n);
        appendAuditEvent(this.db, {
          tenantId:    n.tenantId,
          action:      'contract.expiry_notified',
          entityType:  'contract_instance',
          entityId:    n.contractInstanceId,
          payload: {
            kind:           n.kind,
            daysRemaining:  n.daysRemaining,
            surface:        'in_app',
          },
        });
      } catch (err) {
        logger.error({ err, kind: n.kind }, 'expiry_inapp_dispatch_failed');
      }
    },
    tray: (n) => {
      try {
        this.pendingTrayCount += 1;
        this.deps.onTrayBadge?.(this.pendingTrayCount);
        // Tray surface is secondary; in-app already appended the chain event,
        // so avoid double-appending.  We still log the tray-side dispatch.
        logger.info(
          { kind: n.kind, days: n.daysRemaining, instanceId: n.contractInstanceId },
          'expiry_tray_badge_updated',
        );
      } catch (err) {
        logger.error({ err, kind: n.kind }, 'expiry_tray_dispatch_failed');
      }
    },
  };

  /* ---- Job factory for the Scheduler ---------------------------------- */

  /** Scan hourly at minute 15 (offset avoids clashing with daily/weekly jobs). */
  createScanJob(): {
    id: string;
    spec: { kind: 'daily'; hour: number; minute: number };
    run: () => Promise<void> | void;
  } {
    return {
      id:   'contracts.expiry_scan',
      // Daily at 07:15 is the primary milestone fire cadence.  Hourly cadence
      // is not needed because milestones dedupe via contract_notifications
      // uniqueness — firing once per day is enough to catch every 60/30/7
      // boundary the business requires.
      spec: { kind: 'daily', hour: 7, minute: 15 },
      run:  () => {
        const res = this.scanNow();
        logger.info({ fired: res.fired }, 'expiry_scan_completed');
      },
    };
  }
}

export type { ExpiryNotification };
