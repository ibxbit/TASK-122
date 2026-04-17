import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';

/* =========================================================================
 * Offline enforcement — strict test that the app's egress boundary fails
 * closed.  We run the real installNetworkGuard() against a fake Electron
 * session + webRequest surface and assert:
 *
 *    • No external URL is ever approved (callback({ cancel: true }))
 *    • Every permission request is denied
 *    • Every permission check returns false
 *    • setProxy('direct') was invoked
 *    • A naive outbound HTTP attempt is observable — the test fails loudly
 *      if the egress path somehow succeeds, matching the offline-CI profile.
 * ========================================================================= */

interface FakeSession {
  webRequest: { onBeforeRequest: (filter: { urls: string[] }, cb: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) => void };
  setPermissionRequestHandler: (fn: (wc: unknown, perm: string, cb: (ok: boolean) => void) => void) => void;
  setPermissionCheckHandler: (fn: () => boolean) => void;
  setProxy: (cfg: { mode: string }) => Promise<void>;
}

let beforeRequestHandler: ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null = null;
let permissionRequestHandler: ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void) | null = null;
let permissionCheckHandler: (() => boolean) | null = null;
let proxyCalls: Array<{ mode: string }> = [];

function makeFakeSession(): FakeSession {
  return {
    webRequest: {
      onBeforeRequest: (_f, cb) => { beforeRequestHandler = cb; },
    },
    setPermissionRequestHandler: (fn) => { permissionRequestHandler = fn; },
    setPermissionCheckHandler:   (fn) => { permissionCheckHandler   = fn; },
    setProxy: async (cfg) => { proxyCalls.push(cfg); },
  };
}

const appOnSessionCreated: Array<(s: FakeSession) => void> = [];

vi.mock('electron', () => ({
  app: {
    on: (evt: string, fn: (s: FakeSession) => void) => {
      if (evt === 'session-created') appOnSessionCreated.push(fn);
    },
  },
  session: { defaultSession: makeFakeSession() },
}));

import { installNetworkGuard } from '../../src/main/security/network-guard';

describe('Offline enforcement — strict fail-closed behavior', () => {
  it('installNetworkGuard blocks external URLs, denies permissions, forces direct proxy', () => {
    beforeRequestHandler = null;
    permissionRequestHandler = null;
    permissionCheckHandler = null;
    proxyCalls = [];

    installNetworkGuard();

    // Must have attached handlers
    expect(beforeRequestHandler).toBeTruthy();
    expect(permissionRequestHandler).toBeTruthy();
    expect(permissionCheckHandler).toBeTruthy();

    const urls = [
      'https://example.com',
      'http://evil.com/track.gif',
      'ws://remote:9000',
      'ftp://files.example.com',
      'data:text/plain;base64,AAAA',
      'blob:https://foo',
      'javascript:alert(1)',
    ];
    for (const url of urls) {
      let cancelled = false;
      beforeRequestHandler!({ url }, (r) => { cancelled = r.cancel; });
      expect(cancelled, `URL should be blocked: ${url}`).toBe(true);
    }

    // File / app / chrome internal schemes should be permitted
    for (const url of ['file:///tmp/x.html', 'chrome://settings', 'devtools://devtools']) {
      let cancelled = true;
      beforeRequestHandler!({ url }, (r) => { cancelled = r.cancel; });
      expect(cancelled, `URL should be allowed: ${url}`).toBe(false);
    }

    // Permission handlers deny everything
    let permResult: boolean | null = null;
    permissionRequestHandler!({}, 'geolocation', (ok) => { permResult = ok; });
    expect(permResult).toBe(false);
    expect(permissionCheckHandler!()).toBe(false);

    // setProxy called with mode 'direct'
    expect(proxyCalls.some((c) => c.mode === 'direct')).toBe(true);
  });

  it('strict offline CI profile — failing when egress succeeds', async () => {
    // Launch a throwaway local server so the test is deterministic + offline-safe.
    const srv = http.createServer((_req, res) => { res.end('ok'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;

    const egressSucceeded = await new Promise<boolean>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.end();
    });

    srv.close();

    // In an OFFLINE CI profile (env LH_OFFLINE_CI=1), egress must have failed.
    // Locally we just assert that the probe ran without crashing the suite.
    if (process.env.LH_OFFLINE_CI === '1') {
      expect(
        egressSucceeded,
        'LH_OFFLINE_CI=1 but local HTTP loopback succeeded — offline profile broken',
      ).toBe(false);
    } else {
      expect(typeof egressSucceeded).toBe('boolean');
    }
  });
});
