import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';
import { appendAuditEvent } from '../audit/chain';
import type { ReportSnapshot } from './metrics';

/* =========================================================================
 * Export Service — writes an immutable snapshot to userData/reports/.
 *
 *  • CSV  — RFC-4180, hand-rolled (no deps)
 *  • PDF  — Electron hidden BrowserWindow.printToPDF, offline-only
 *  • chmod 0o444 after write so the file cannot be mutated in place
 *  • sha256 is recorded in audit_events as tamper-evident proof
 * ========================================================================= */

export interface ExportResult {
  path:        string;
  sha256:      string;
  size_bytes:  number;
  format:      'csv' | 'pdf';
}

function reportsDir(): string {
  return path.join(app.getPath('userData'), 'reports');
}

async function writeImmutable(filePath: string, data: Buffer | string): Promise<ExportResult> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  await fs.writeFile(filePath, buf);
  try { await fs.chmod(filePath, 0o444); } catch { /* Windows best-effort */ }
  return {
    path:        filePath,
    sha256:      crypto.createHash('sha256').update(buf).digest('hex'),
    size_bytes:  buf.length,
    format:      filePath.endsWith('.pdf') ? 'pdf' : 'csv',
  };
}

/* ---------- CSV ---------------------------------------------------------- */

function csv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(snapshot: ReportSnapshot, destinationPath?: string): Promise<ExportResult> {
  const L: string[] = [];
  L.push(`# snapshotId,${csv(snapshot.snapshotId)}`);
  L.push(`# generatedAt,${new Date(snapshot.generatedAt * 1000).toISOString()}`);
  L.push(`# tenantId,${csv(snapshot.filters.tenantId)}`);
  L.push(`# storeId,${csv(snapshot.filters.storeId ?? '')}`);
  L.push(`# hourOfDay,${csv(snapshot.filters.hourOfDay ?? '')}`);
  L.push(`# from,${new Date(snapshot.filters.from * 1000).toISOString()}`);
  L.push(`# to,${new Date(snapshot.filters.to   * 1000).toISOString()}`);
  L.push('');

  const m = snapshot.metrics;
  L.push('section,metric,value');
  L.push(`summary,orders_total,${m.orders.total}`);
  L.push(`summary,orders_completed,${m.orders.completed}`);
  L.push(`summary,orders_cancelled,${m.orders.cancelled}`);
  L.push(`summary,revenue_cents,${m.revenue.revenue_cents}`);
  L.push(`summary,currency,${csv(m.revenue.currency)}`);
  L.push(`summary,occupancy_rate,${m.occupancy.occupancy_rate.toFixed(4)}`);
  L.push(`summary,cancellation_rate,${m.cancellation.rate.toFixed(4)}`);
  L.push(`summary,repurchase_rate,${m.repurchase.rate.toFixed(4)}`);
  L.push('');

  L.push('hot_slot_hour,orders,revenue_cents');
  for (const s of m.hotSlots) L.push(`${s.hour},${s.orders},${s.revenue_cents}`);

  L.push('');
  L.push('hot_seat_room_id,code,name,kind,avg_count,avg_capacity,occupancy_rate,snapshot_count');
  for (const r of m.hotSeatRooms) {
    L.push([csv(r.seat_room_id), csv(r.code), csv(r.name), csv(r.kind),
            r.avg_count.toFixed(2), r.avg_capacity.toFixed(2),
            r.occupancy_rate.toFixed(4), r.snapshot_count].join(','));
  }

  const file   = destinationPath
    ? path.resolve(destinationPath)
    : path.join(reportsDir(), `${snapshot.snapshotId}.csv`);
  const result = await writeImmutable(file, L.join('\r\n') + '\r\n');
  recordAudit(snapshot, result);
  return result;
}

/* ---------- PDF ---------------------------------------------------------- */

function pdfHtml(s: ReportSnapshot): string {
  const pct   = (n: number) => `${(n * 100).toFixed(2)}%`;
  const money = (cents: number, cur: string) =>
    new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(cents / 100);
  const rFrom = new Date(s.filters.from * 1000).toISOString().slice(0, 10);
  const rTo   = new Date(s.filters.to   * 1000).toISOString().slice(0, 10);
  const extra = [
    s.filters.storeId            ? `store ${s.filters.storeId}` : '',
    s.filters.hourOfDay !== undefined ? `hour ${s.filters.hourOfDay}` : '',
  ].filter(Boolean).join(' · ');
  const slots = s.metrics.hotSlots.map((x) =>
    `<tr><td>${String(x.hour).padStart(2,'0')}:00</td><td>${x.orders}</td><td>${money(x.revenue_cents, s.metrics.revenue.currency)}</td></tr>`
  ).join('') || '<tr><td colspan="3" style="text-align:center;color:#999">No data</td></tr>';

  return `<!doctype html><html><head><meta charset="utf-8"/><style>
*{box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI",sans-serif;color:#111;margin:0;padding:28px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#666;font-size:11px;margin-bottom:20px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
.kpi{border:1px solid #ddd;border-radius:6px;padding:10px}
.kpi .l{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.kpi .v{font-size:20px;font-weight:600;margin-top:4px}
.section{margin-top:22px;font-size:13px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}
th{background:#f5f5f5;font-weight:600}
.fp{position:fixed;bottom:14px;left:28px;right:28px;color:#999;font-size:9px;font-family:monospace}
</style></head><body>
<h1>LeaseHub Operations Report</h1>
<div class="sub">${rFrom} → ${rTo}${extra ? ` · ${extra}` : ''} · tenant ${s.filters.tenantId}</div>
<div class="kpis">
  <div class="kpi"><div class="l">Orders</div><div class="v">${s.metrics.orders.total}</div></div>
  <div class="kpi"><div class="l">Revenue</div><div class="v">${money(s.metrics.revenue.revenue_cents, s.metrics.revenue.currency)}</div></div>
  <div class="kpi"><div class="l">Occupancy</div><div class="v">${pct(s.metrics.occupancy.occupancy_rate)}</div></div>
  <div class="kpi"><div class="l">Cancellation</div><div class="v">${pct(s.metrics.cancellation.rate)}</div></div>
  <div class="kpi"><div class="l">Repurchase</div><div class="v">${pct(s.metrics.repurchase.rate)}</div></div>
  <div class="kpi"><div class="l">Completed</div><div class="v">${s.metrics.orders.completed}</div></div>
</div>
<div class="section">Hot Time Slots</div>
<table><thead><tr><th>Hour</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>${slots}</tbody></table>
<div class="fp">snapshot ${s.snapshotId} · generated ${new Date(s.generatedAt * 1000).toISOString()}</div>
</body></html>`;
}

export async function exportPdf(snapshot: ReportSnapshot, destinationPath?: string): Promise<ExportResult> {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1400,
    webPreferences: {
      offscreen:        true,
      javascript:       false,             // static HTML only; blocks script execution
      sandbox:          true,
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  try {
    const dataUrl = 'data:text/html;charset=utf-8;base64,' +
      Buffer.from(pdfHtml(snapshot), 'utf8').toString('base64');
    await win.loadURL(dataUrl);

    const buf = await win.webContents.printToPDF({
      pageSize:        'A4',
      printBackground: true,
      margins:         { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      preferCSSPageSize: false,
    });

    const file   = destinationPath
      ? path.resolve(destinationPath)
      : path.join(reportsDir(), `${snapshot.snapshotId}.pdf`);
    const result = await writeImmutable(file, buf);
    recordAudit(snapshot, result);
    return result;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/* ---------- Audit ------------------------------------------------------- */

function recordAudit(snapshot: ReportSnapshot, result: ExportResult): void {
  try {
    appendAuditEvent(getDb(), {
      tenantId:    snapshot.filters.tenantId,
      action:      'report.generated',
      actorUserId: null,
      entityType:  'report',
      entityId:    snapshot.snapshotId,
      payload: {
        snapshotId: snapshot.snapshotId,
        format:     result.format,
        path:       result.path,
        sha256:     result.sha256,
        size_bytes: result.size_bytes,
        filters:    snapshot.filters,
      },
    });
  } catch (err) {
    logger.error({ err, snapshotId: snapshot.snapshotId, format: result.format }, 'report_audit_failed');
  }
}
