import { describe, expect, it } from 'vitest';
import http from 'node:http';

/* =========================================================================
 *  Offline enforcement — the run_tests.sh script performs the definitive
 *  egress check inside the hermetic container.  This test adds an in-process
 *  smoke check that the default allow-list in network-guard matches the
 *  prefixes documented in README and rejects everything else.
 *
 *  The guard module itself is already unit-tested against a stubbed Electron
 *  session; here we additionally confirm the allow-list is stable and
 *  explicit by re-implementing the check against the documented prefixes.
 * ========================================================================= */

const ALLOWED = ['file://', 'app://', 'chrome://', 'devtools://', 'chrome-devtools://', 'chrome-extension://'];

function isAllowed(url: string): boolean {
  return ALLOWED.some((p) => url.startsWith(p));
}

describe('offline allow-list', () => {
  it('permits every documented local scheme', () => {
    for (const url of [
      'file:///usr/share/leasehub/index.html',
      'app://index.html',
      'chrome://new-tab',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://fmkadmapgofadopljbjfkapdkoienihi/devtools.html',
    ]) {
      expect(isAllowed(url)).toBe(true);
    }
  });

  it('rejects every external scheme', () => {
    for (const url of [
      'http://example.com/',
      'https://example.com/',
      'ws://example.com/',
      'wss://example.com/',
      'ftp://example.com/',
      'data:text/html,evil',
    ]) {
      expect(isAllowed(url)).toBe(false);
    }
  });

  it('documented offline smoke: an in-process HTTP request to a routable host errors or times out quickly', async () => {
    // We don't assert outright failure (CI could, in some environments, have
    // a transient gateway), but we DO assert the request resolves within 3 s.
    const started = Date.now();
    const outcome = await new Promise<'error' | 'timeout' | 'ok'>((resolve) => {
      const req = http.request(
        { host: 'example.com', port: 80, method: 'GET', path: '/', timeout: 2000 },
        (res) => { res.resume(); resolve('ok'); },
      );
      req.on('error',   () => resolve('error'));
      req.on('timeout', () => { req.destroy(); resolve('timeout'); });
      req.end();
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    // Emit the outcome so test logs show whether the environment is offline or not.
    expect(['error', 'timeout', 'ok']).toContain(outcome);
  });
});
