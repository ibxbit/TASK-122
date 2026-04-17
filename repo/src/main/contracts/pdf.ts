import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* =========================================================================
 * Contract PDF Generation
 *   Offline: offscreen BrowserWindow + printToPDF, no network fetches.
 *   javascript:false so the transient window cannot execute code.
 *   `freeze: true` sets chmod 0o444 post-write (used at signing time).
 * ========================================================================= */

export interface PdfResult {
  path:        string;
  sha256:      string;
  size_bytes:  number;
}

export interface ContractPdfInput {
  instanceId:       string;
  instanceNumber:   string;
  tenantId:         string;
  templateCode:     string;
  templateVersion:  number;
  title:            string;
  renderedBody:     string;
  variables:        Record<string, unknown>;
  effectiveFrom?:   number | null;
  effectiveTo?:     number | null;
  generatedAt?:     number;
  freeze?:          boolean;
}

function contractsDir(): string {
  return path.join(app.getPath('userData'), 'contracts');
}

export async function generateContractPdf(input: ContractPdfInput): Promise<PdfResult> {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1400,
    webPreferences: {
      offscreen:        true,
      javascript:       false,
      sandbox:          true,
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  try {
    const dataUrl = 'data:text/html;charset=utf-8;base64,' +
      Buffer.from(buildHtml(input), 'utf8').toString('base64');
    await win.loadURL(dataUrl);

    const buf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });

    const file = path.join(contractsDir(), `${input.instanceId}.pdf`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);

    if (input.freeze) {
      try { await fs.chmod(file, 0o444); } catch { /* Windows best-effort */ }
    }

    return {
      path:       file,
      sha256:     crypto.createHash('sha256').update(buf).digest('hex'),
      size_bytes: buf.length,
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/* ------------------------------------------------------------------ */

function buildHtml(i: ContractPdfInput): string {
  const iso = (t?: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '—');
  const vars = Object.entries(i.variables)
    .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join('');
  const generated = new Date((i.generatedAt ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();

  return `<!doctype html><html><head><meta charset="utf-8"/><style>
*{box-sizing:border-box}
body{font-family:"Segoe UI",sans-serif;color:#111;margin:0;padding:32px;font-size:12px;line-height:1.55}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#666;font-size:11px;margin-bottom:20px}
.meta{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:11px}
.meta td{padding:4px 6px;border-bottom:1px solid #eee}
.meta td.k{color:#666;width:30%}
.body{white-space:pre-wrap;border:1px solid #ddd;border-radius:6px;padding:16px;background:#fafafa}
.fp{position:fixed;bottom:14px;left:32px;right:32px;color:#999;font-size:9px;font-family:monospace}
</style></head><body>
<h1>${esc(i.title)}</h1>
<div class="sub">Contract ${esc(i.instanceNumber)} · template ${esc(i.templateCode)} v${i.templateVersion}</div>
<table class="meta">
  <tr><td class="k">Effective from</td><td>${iso(i.effectiveFrom)}</td></tr>
  <tr><td class="k">Effective to</td>  <td>${iso(i.effectiveTo)}</td></tr>
  ${vars}
</table>
<div class="body">${esc(i.renderedBody)}</div>
<div class="fp">instance ${esc(i.instanceId)} · tenant ${esc(i.tenantId)} · generated ${generated}</div>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}
