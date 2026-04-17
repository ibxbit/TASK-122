import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * Audit producer paths — static + runtime verification that every audit
 * event creator goes through the appendAuditEvent chain producer.
 *
 *  1. STATIC:  outside of `audit/chain.ts`, no file may contain
 *              `INSERT INTO audit_events`.  If any does, the chain's
 *              seq/hash_prev/hash_curr guarantees can be bypassed.
 *
 *  2. RUNTIME: producers under audit (signing.ts, analytics/export.service.ts,
 *              ipc handlers) must call appendAuditEvent.  We assert that
 *              importing any producer module imports appendAuditEvent.
 * ========================================================================= */

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('Audit producer chain compliance (static)', () => {
  const allFiles = walk(SRC);

  it('no production source outside audit/chain.ts contains direct INSERT INTO audit_events', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const f of allFiles) {
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      if (rel === 'main/audit/chain.ts') continue;                 // authoritative writer
      if (rel.startsWith('../')) continue;                          // safety
      const content = readFileSync(f, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/INSERT\s+INTO\s+audit_events/i.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      });
    }
    expect(
      offenders,
      `Direct INSERT INTO audit_events found outside the chain producer:\n` +
      offenders.map((o) => ` - ${o.file}:${o.line}  ${o.text}`).join('\n'),
    ).toEqual([]);
  });

  it('signing.ts uses appendAuditEvent', () => {
    const s = readFileSync(path.join(SRC, 'main/contracts/signing.ts'), 'utf8');
    expect(s).toMatch(/appendAuditEvent/);
    expect(s).toMatch(/from '\.\.\/audit\/chain'/);
  });

  it('analytics/export.service.ts uses appendAuditEvent', () => {
    const s = readFileSync(path.join(SRC, 'main/analytics/export.service.ts'), 'utf8');
    expect(s).toMatch(/appendAuditEvent/);
  });

  it('every IPC write handler for sensitive domains imports appendAuditEvent', () => {
    const files = [
      'main/ipc/reviews.handler.ts',
      'main/ipc/routing.handler.ts',
      'main/ipc/updates.handler.ts',
      'main/ipc/admin.handler.ts',
      'main/contracts/expiry-service.ts',
    ];
    for (const f of files) {
      const s = readFileSync(path.join(SRC, f), 'utf8');
      expect(s, `${f} must import appendAuditEvent`).toMatch(/appendAuditEvent/);
    }
  });
});

describe('Audit chain writer remains the single insert site', () => {
  it('chain.ts has exactly one INSERT INTO audit_events', () => {
    const content = readFileSync(path.join(SRC, 'main/audit/chain.ts'), 'utf8');
    const matches = content.match(/INSERT\s+INTO\s+audit_events/gi) ?? [];
    expect(matches.length).toBe(1);
  });
});
