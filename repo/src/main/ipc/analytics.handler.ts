import { registerGuarded } from '../access/enforce';
import { getDb } from '../db';
import { buildReportSnapshot } from '../analytics/metrics';
import { exportCsv, exportPdf } from '../analytics/export.service';
import { chooseExportDestination, validateDestination } from './export-dialog';

/* =========================================================================
 * Analytics IPC Handlers
 *
 *  analytics:snapshot  — build a report snapshot for the caller's tenant
 *  analytics:export    — export snapshot as CSV + PDF
 *
 *  All handlers run through registerGuarded() so session + ABAC is enforced.
 * ========================================================================= */

interface SnapshotPayload {
  from?:      number;
  to?:        number;
  storeId?:   string;
  hourOfDay?: number;
}

interface ExportPayload {
  snapshotId?:     string;
  from?:           number;
  to?:             number;
  storeId?:        string;
  /** When true, prompt the user for a destination folder.  When a path is
   *  supplied in csvPath/pdfPath, it is used (after validation) instead. */
  chooseDestination?: boolean;
  csvPath?:        string;
  pdfPath?:        string;
}

export function registerAnalyticsHandlers(): void {
  // ── analytics:snapshot ──────────────────────────────────────────────
  registerGuarded<SnapshotPayload, unknown>(
    'analytics:snapshot',
    { permission: 'analytics.view', type: 'api', action: 'read' },
    (ctx, payload) => {
      const now = Math.floor(Date.now() / 1000);
      const from = payload.from ?? now - 86400;     // default: last 24h
      const to   = payload.to   ?? now;

      return buildReportSnapshot(getDb(), {
        tenantId:  ctx.tenantId,
        from,
        to,
        storeId:   payload.storeId,
        hourOfDay: payload.hourOfDay,
      });
    },
  );

  // ── analytics:export ────────────────────────────────────────────────
  registerGuarded<ExportPayload, unknown>(
    'analytics:export',
    { permission: 'analytics.export', type: 'api', action: 'read' },
    async (ctx, payload) => {
      const now = Math.floor(Date.now() / 1000);
      const snap = buildReportSnapshot(getDb(), {
        tenantId: ctx.tenantId,
        from:     payload.from ?? now - 86400,
        to:       payload.to   ?? now,
        storeId:  payload.storeId,
      });

      // Resolve destinations.  Precedence:
      //   1. Explicit csvPath/pdfPath (validated)
      //   2. chooseDestination=true → showSaveDialog for each
      //   3. Default userData/reports path
      let csvDest: string | undefined;
      let pdfDest: string | undefined;

      if (payload.csvPath) csvDest = await validateDestination(payload.csvPath, 'csv');
      if (payload.pdfPath) pdfDest = await validateDestination(payload.pdfPath, 'pdf');

      if (payload.chooseDestination && !csvDest) {
        const chosen = await chooseExportDestination({
          title:       'Save Analytics Report (CSV)',
          defaultName: `${snap.snapshotId}.csv`,
          kind:        'csv',
        });
        if (chosen) csvDest = chosen.absolutePath;
      }
      if (payload.chooseDestination && !pdfDest) {
        const chosen = await chooseExportDestination({
          title:       'Save Analytics Report (PDF)',
          defaultName: `${snap.snapshotId}.pdf`,
          kind:        'pdf',
        });
        if (chosen) pdfDest = chosen.absolutePath;
      }

      const [csvResult, pdfResult] = await Promise.all([
        exportCsv(snap, csvDest),
        exportPdf(snap, pdfDest),
      ]);

      return { csv: csvResult, pdf: pdfResult };
    },
  );
}
