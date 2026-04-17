import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Database } from 'better-sqlite3';
import { logger } from '../logger';
import { verifyAuditChain, type AuditRow, type VerifyResult } from './chain';
import { signBuffer, getPublicKeyPem } from './bundle-signer';

/* =========================================================================
 * Audit Export — ZIP bundle of { events.csv, events.pdf, manifest.json }
 *
 *  • User-facing filter (user / action / entity / time) narrows the CSV/PDF
 *  • Chain verification runs over the unfiltered time range so integrity
 *    is proven against the whole tenant chain, not a filtered subset
 *  • manifest.json records query, counts, chain verdict, file sha256s
 *  • Output: userData/audit-exports/<bundleId>.zip (chmod 0o444)
 *  • No third-party ZIP library — minimal PKZip writer using built-in zlib
 * ========================================================================= */

export interface AuditExportQuery {
  tenantId:     string;
  from?:        number;
  to?:          number;
  userId?:      string;            // actor_user_id
  action?:      string;            // exact match
  entityType?:  string;
  entityId?:    string;
  /** Explicit user-chosen destination (absolute path to .zip).
   *  When omitted, falls back to userData/audit-exports/<bundleId>.zip so
   *  scheduled / headless callers still work. */
  destinationPath?: string;
}

export interface AuditExportResult {
  path:           string;
  sha256:         string;
  size_bytes:     number;
  bundleId:       string;
  signatureHex:   string;      // RSA-SHA256 signature of manifest.json
}

export async function exportAuditBundle(db: Database, query: AuditExportQuery): Promise<AuditExportResult> {
  const bundleId   = `aex_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const generated  = Math.floor(Date.now() / 1000);

  // ── 1. Fetch events matching the user filter ────────────────────────────
  const { where, params } = buildWhere(query);
  const events = db.prepare(`
    SELECT * FROM audit_events
     WHERE ${where} AND seq IS NOT NULL
     ORDER BY seq ASC
  `).all(params) as AuditRow[];

  // ── 2. Verify chain integrity over the TIME range, unfiltered ───────────
  const verify = verifyAuditChain(db, query.tenantId, { from: query.from, to: query.to });

  // ── 3. Build artefacts ──────────────────────────────────────────────────
  const csv = Buffer.from(buildCsv(events), 'utf8');
  const pdf = await buildPdf({
    bundleId, generatedAt: generated, query, events, verify,
  });

  const manifestObj = buildManifest({
    bundleId, generatedAt: generated, query, events, verify,
    files: [
      { name: 'events.csv', size_bytes: csv.length, sha256: sha256(csv) },
      { name: 'events.pdf', size_bytes: pdf.length, sha256: sha256(pdf) },
    ],
  });
  const manifest = Buffer.from(JSON.stringify(manifestObj, null, 2), 'utf8');

  // ── 4. Cryptographic signature of manifest ───────────────────────────────
  let signatureBuf: Buffer;
  let publicKeyPem: string;
  try {
    signatureBuf = signBuffer(manifest);
    publicKeyPem = getPublicKeyPem();
  } catch (err) {
    logger.warn({ err }, 'audit_bundle_signing_unavailable_falling_back');
    signatureBuf = Buffer.alloc(0);
    publicKeyPem = '';
  }

  // ── 5. Pack into ZIP (STORE + DEFLATE depending on content) ─────────────
  const zipEntries: ZipEntry[] = [
    { name: 'events.csv',    data: csv      },
    { name: 'events.pdf',    data: pdf      },
    { name: 'manifest.json', data: manifest },
  ];
  if (signatureBuf.length > 0) {
    zipEntries.push({ name: 'manifest.sig',       data: signatureBuf });
    zipEntries.push({ name: 'signing-key.pub.pem', data: Buffer.from(publicKeyPem, 'utf8') });
  }
  const zipBuf = buildZip(zipEntries);

  // ── 6. Write immutable artefact ─────────────────────────────────────────
  //  If the caller supplied a user-chosen destination, honour it (validated
  //  at the IPC boundary).  Otherwise write to the default userData location.
  const outPath = query.destinationPath
    ? path.resolve(query.destinationPath)
    : path.join(app.getPath('userData'), 'audit-exports', `${bundleId}.zip`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, zipBuf);
  try { await fs.chmod(outPath, 0o444); } catch { /* Windows best-effort */ }

  const result: AuditExportResult = {
    path:         outPath,
    sha256:       sha256(zipBuf),
    size_bytes:   zipBuf.length,
    bundleId,
    signatureHex: signatureBuf.toString('hex'),
  };
  logger.info({ bundleId, events: events.length, verified: verify.ok, signed: signatureBuf.length > 0 }, 'audit_bundle_exported');
  return result;
}

/* ------------------------------------------------------------------ *
 *  CSV                                                                *
 * ------------------------------------------------------------------ */

function buildCsv(events: AuditRow[]): string {
  const header = [
    'id','tenant_id','seq','occurred_at_iso','action',
    'actor_user_id','entity_type','entity_id',
    'window_kind','hash_prev','hash_curr','payload',
  ];
  const lines: string[] = [header.join(',')];
  for (const e of events) {
    lines.push([
      csv(e.id),
      csv(e.tenant_id),
      csv(e.seq ?? ''),
      csv(new Date(e.occurred_at * 1000).toISOString()),
      csv(e.action),
      csv(e.actor_user_id ?? ''),
      csv(e.entity_type   ?? ''),
      csv(e.entity_id     ?? ''),
      csv(e.window_kind   ?? ''),
      csv(e.hash_prev     ?? ''),
      csv(e.hash_curr),
      csv(e.payload       ?? ''),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function csv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ *
 *  Manifest                                                           *
 * ------------------------------------------------------------------ */

interface ManifestFile { name: string; size_bytes: number; sha256: string; }

interface ManifestInput {
  bundleId:    string;
  generatedAt: number;
  query:       AuditExportQuery;
  events:      AuditRow[];
  verify:      VerifyResult;
  files:       ManifestFile[];
}

function buildManifest(i: ManifestInput): Record<string, unknown> {
  const byAction: Record<string, number> = {};
  for (const e of i.events) byAction[e.action] = (byAction[e.action] ?? 0) + 1;

  return {
    bundleId:      i.bundleId,
    generatedAt:   new Date(i.generatedAt * 1000).toISOString(),
    query: {
      tenantId:    i.query.tenantId,
      from:        i.query.from ? new Date(i.query.from * 1000).toISOString() : null,
      to:          i.query.to   ? new Date(i.query.to   * 1000).toISOString() : null,
      userId:      i.query.userId     ?? null,
      action:      i.query.action     ?? null,
      entityType:  i.query.entityType ?? null,
      entityId:    i.query.entityId   ?? null,
    },
    counts: {
      events:    i.events.length,
      byAction,
    },
    chain: {
      verified:        i.verify.ok,
      totalInRange:    i.verify.totalEvents,
      firstSeq:        i.verify.firstSeq,
      lastSeq:         i.verify.lastSeq,
      anchorHashPrev:  i.verify.anchorHashPrev,
      lastHash:        i.verify.lastHash,
      break:           i.verify.break ?? null,
    },
    files: i.files,
  };
}

/* ------------------------------------------------------------------ *
 *  PDF  (offscreen BrowserWindow.printToPDF — offline)                *
 * ------------------------------------------------------------------ */

const PDF_EVENT_LIMIT = 200;

async function buildPdf(i: ManifestInput): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1400,
    webPreferences: {
      offscreen: true, javascript: false, sandbox: true,
      contextIsolation: true, nodeIntegration: false,
    },
  });
  try {
    const html = pdfHtml(i);
    const dataUrl = 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64');
    await win.loadURL(dataUrl);
    return await win.webContents.printToPDF({
      pageSize: 'A4', printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function pdfHtml(i: ManifestInput): string {
  const truncated = i.events.length > PDF_EVENT_LIMIT;
  const sample    = truncated ? i.events.slice(0, PDF_EVENT_LIMIT) : i.events;

  const rows = sample.map((e) =>
    `<tr>
       <td class="mono">${e.seq}</td>
       <td>${escH(new Date(e.occurred_at * 1000).toISOString().replace('T',' ').slice(0,19))}</td>
       <td>${escH(e.action)}</td>
       <td>${escH(e.actor_user_id ?? '—')}</td>
       <td>${escH(e.entity_type ?? '')} ${escH(e.entity_id ?? '')}</td>
       <td class="mono">${escH(e.hash_curr.slice(0, 12))}…</td>
     </tr>`
  ).join('');

  const verifyBadge = i.verify.ok
    ? '<span class="ok">VERIFIED</span>'
    : `<span class="fail">BROKEN at seq ${i.verify.break?.seq} (${escH(i.verify.break?.reason ?? '')})</span>`;

  return `<!doctype html><html><head><meta charset="utf-8"/><style>
*{box-sizing:border-box}
body{font-family:"Segoe UI",sans-serif;color:#111;margin:0;padding:28px;font-size:11px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#666;font-size:10px;margin-bottom:18px}
.meta{border:1px solid #ddd;border-radius:6px;padding:10px 14px;margin-bottom:16px}
.meta div{margin:2px 0}
.meta .k{color:#666;display:inline-block;width:110px}
.ok{color:#047857;font-weight:600}
.fail{color:#b91c1c;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:10px}
th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #eee;vertical-align:top}
th{background:#f5f5f5}
.mono{font-family:Consolas,monospace}
.note{margin-top:10px;color:#999;font-size:9px}
.fp{position:fixed;bottom:14px;left:28px;right:28px;color:#999;font-size:9px;font-family:monospace}
</style></head><body>
<h1>LeaseHub Audit Export</h1>
<div class="sub">Bundle ${escH(i.bundleId)} · generated ${new Date(i.generatedAt * 1000).toISOString()}</div>

<div class="meta">
  <div><span class="k">Tenant</span> ${escH(i.query.tenantId)}</div>
  <div><span class="k">Range</span>  ${i.query.from ? escH(new Date(i.query.from * 1000).toISOString()) : '—'} → ${i.query.to ? escH(new Date(i.query.to * 1000).toISOString()) : '—'}</div>
  <div><span class="k">Filter</span> user=${escH(i.query.userId ?? 'any')} · action=${escH(i.query.action ?? 'any')} · entity=${escH(i.query.entityType ?? 'any')}/${escH(i.query.entityId ?? 'any')}</div>
  <div><span class="k">Events</span> ${i.events.length}</div>
  <div><span class="k">Chain</span>  ${verifyBadge}</div>
  <div><span class="k">Anchor</span> <span class="mono">${escH(i.verify.anchorHashPrev ?? '—')}</span></div>
  <div><span class="k">Tip</span>    <span class="mono">${escH(i.verify.lastHash ?? '—')}</span></div>
</div>

<table>
  <thead><tr><th>Seq</th><th>When (UTC)</th><th>Action</th><th>Actor</th><th>Entity</th><th>Hash</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999">No events</td></tr>'}</tbody>
</table>
${truncated ? `<div class="note">Showing first ${PDF_EVENT_LIMIT} of ${i.events.length} events. Full set is in events.csv.</div>` : ''}
<div class="fp">bundle ${escH(i.bundleId)} · tenant ${escH(i.query.tenantId)}</div>
</body></html>`;
}

function escH(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[c]!);
}

/* ------------------------------------------------------------------ *
 *  Minimal PKZip writer (STORE for empty, DEFLATE otherwise).         *
 * ------------------------------------------------------------------ */

interface ZipEntry { name: string; data: Buffer; }

const LFH_SIG  = 0x04034b50;
const CDH_SIG  = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function buildZip(entries: ZipEntry[]): Buffer {
  const { time, date } = dosDateTime(new Date());
  const parts:       Buffer[] = [];
  const centralDir:  Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf          = Buffer.from(entry.name, 'utf8');
    const uncompressedSize = entry.data.length;
    const rawCrc           = crc32(entry.data);

    let compressed: Buffer;
    let method:     number;
    if (uncompressedSize === 0) {
      compressed = Buffer.alloc(0);
      method     = 0;                   // STORE
    } else {
      compressed = zlib.deflateRawSync(entry.data);
      method     = 8;                   // DEFLATE
    }
    const compressedSize = compressed.length;

    // Local file header
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0,  6);           // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(rawCrc, 14);
    lfh.writeUInt32LE(compressedSize,   18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(nameBuf.length,   26);
    lfh.writeUInt16LE(0, 28);
    nameBuf.copy(lfh, 30);

    parts.push(lfh, compressed);

    // Central directory entry
    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0,  8);           // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(date, 14);
    cdh.writeUInt32LE(rawCrc, 16);
    cdh.writeUInt32LE(compressedSize,   20);
    cdh.writeUInt32LE(uncompressedSize, 24);
    cdh.writeUInt16LE(nameBuf.length,   28);
    cdh.writeUInt16LE(0, 30);           // extra
    cdh.writeUInt16LE(0, 32);           // comment
    cdh.writeUInt16LE(0, 34);           // disk
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(offset, 42);      // LFH offset
    nameBuf.copy(cdh, 46);
    centralDir.push(cdh);

    offset += lfh.length + compressed.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of centralDir) { parts.push(c); cdSize += c.length; }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize,  12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */

function buildWhere(q: AuditExportQuery): { where: string; params: Record<string, unknown> } {
  const parts  = ['tenant_id = @tenantId'];
  const params: Record<string, unknown> = { tenantId: q.tenantId };
  if (q.from       !== undefined) { parts.push('occurred_at >= @from');     params.from = q.from; }
  if (q.to         !== undefined) { parts.push('occurred_at <  @to');       params.to   = q.to;   }
  if (q.userId)                   { parts.push('actor_user_id = @userId');  params.userId = q.userId; }
  if (q.action)                   { parts.push('action = @action');         params.action = q.action; }
  if (q.entityType)               { parts.push('entity_type = @entityType'); params.entityType = q.entityType; }
  if (q.entityId)                 { parts.push('entity_id = @entityId');    params.entityId = q.entityId; }
  return { where: parts.join(' AND '), params };
}

function sha256(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}
