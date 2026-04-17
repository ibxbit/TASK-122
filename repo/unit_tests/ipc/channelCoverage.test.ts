import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/* =========================================================================
 * IPC channel coverage — guarantees the handler surface matches the
 * documented registry and the renderer callsites.
 *
 *  1. Walk src/main/ipc/** + access/enforce.ts and collect every channel
 *     registered via `registerGuarded('...'` or `ipcMain.handle('...'`.
 *     Generics are manually skipped so nested `<Record<string, never>,
 *     unknown>` types don't confuse a naive regex.
 *  2. Walk src/renderer/** and collect every `bridge.invoke('...'` or
 *     `window.leasehub.invoke('...'`.
 *  3. Assert: every invoke target has a registered handler.
 *  4. Assert: every registered namespace appears in the README registry.
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

/**
 * Handler-side extractor.  Finds `registerGuarded` or `ipcMain.handle`,
 * then walks the source manually to skip optional `<…>` generics (with
 * nesting) and `(` before capturing the first quoted string literal.
 */
function extractHandlerChannels(src: string): Set<string> {
  const out = new Set<string>();
  const tokenRe = /\b(registerGuarded|ipcMain\.handle)\b/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(src)) !== null) {
    let i = match.index + match[0].length;

    const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };

    skipWs();
    if (src[i] === '<') {
      // Skip generics with nesting support.
      let depth = 1; i++;
      while (i < src.length && depth > 0) {
        if (src[i] === '<') depth++;
        else if (src[i] === '>') depth--;
        i++;
      }
    }
    skipWs();
    if (src[i] !== '(') continue;
    i++;
    skipWs();
    if (src[i] !== "'" && src[i] !== '"') continue;  // channel is an identifier (e.g. the wrapper def)
    const quote = src[i]; i++;
    let channel = '';
    while (i < src.length && src[i] !== quote) { channel += src[i]; i++; }
    if (channel.length > 0) out.add(channel);
  }
  return out;
}

const INVOKE_RE = /(?:bridge|window\.leasehub)\.invoke\(\s*['"]([^'"]+)['"]/g;

function extractInvokeTargets(src: string): Set<string> {
  const out = new Set<string>();
  INVOKE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOKE_RE.exec(src)) !== null) out.add(m[1]);
  return out;
}

describe('IPC channel coverage', () => {
  const handlerFiles = walk(path.join(SRC, 'main')).filter((f) => {
    const p = f.replace(/\\/g, '/');
    return p.includes('/main/ipc/') || p.endsWith('/access/enforce.ts');
  });
  const rendererFiles = walk(path.join(SRC, 'renderer'));

  const registered = new Set<string>();
  for (const f of handlerFiles) {
    for (const ch of extractHandlerChannels(readFileSync(f, 'utf8'))) registered.add(ch);
  }
  const invoked = new Set<string>();
  for (const f of rendererFiles) {
    for (const ch of extractInvokeTargets(readFileSync(f, 'utf8'))) invoked.add(ch);
  }

  it('registers every channel the renderer invokes', () => {
    const missing: string[] = [];
    for (const ch of invoked) {
      if (!registered.has(ch)) missing.push(ch);
    }
    expect(
      missing,
      `Renderer invokes channels with no registered handler:\n  ${missing.join('\n  ')}\n\nRegistered:\n  ${[...registered].sort().join('\n  ')}`,
    ).toEqual([]);
  });

  it('registered channel count covers all product domains', () => {
    // Lower bound: contracts(10) + audit(3) + analytics(2) + session(4)
    //   + reviews(7) + routing(6) + updates(5) + admin(11) + access(1) = 49.
    // We assert ≥ 45 to leave headroom for trivial refactors while still
    // catching large-scale regressions (e.g. an entire handler module
    // becoming unreachable).
    expect(registered.size).toBeGreaterThanOrEqual(45);
  });

  it('every registered channel namespace appears at least once in README', () => {
    const readme = readFileSync(
      path.resolve(__dirname, '../../README.md'), 'utf8',
    );
    const namespaces = new Set<string>();
    for (const ch of registered) namespaces.add(ch.split(':')[0]);
    const missing: string[] = [];
    for (const ns of namespaces) {
      if (!readme.includes(`\`${ns}:`)) missing.push(ns);
    }
    expect(
      missing,
      `IPC namespaces absent from README:\n  ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
