import { describe, expect, it, vi } from 'vitest';

/* =========================================================================
 *  Network guard — exercise the isAllowed prefix gate via installNetworkGuard.
 *  Electron's session + app are stubbed in-memory; we capture the webRequest
 *  callback and replay URLs through it.
 * ========================================================================= */

const onBeforeRequestSpy = vi.fn();
const setPermissionHandler = vi.fn();
const setPermissionCheck  = vi.fn();
const setProxy            = vi.fn().mockResolvedValue(undefined);

const session = {
  defaultSession: {
    webRequest: { onBeforeRequest: onBeforeRequestSpy },
    setPermissionRequestHandler: setPermissionHandler,
    setPermissionCheckHandler:  setPermissionCheck,
    setProxy,
  },
};

vi.mock('electron', () => ({
  session,
  app: { on: vi.fn() },
}));

import { installNetworkGuard } from '../../src/main/security/network-guard';

describe('installNetworkGuard()', () => {
  it('registers onBeforeRequest with <all_urls> filter', () => {
    installNetworkGuard();
    expect(onBeforeRequestSpy).toHaveBeenCalledTimes(1);
    const [filter, handler] = onBeforeRequestSpy.mock.calls[0];
    expect(filter).toEqual({ urls: ['<all_urls>'] });
    expect(typeof handler).toBe('function');

    const calls: Array<{ url: string; cancel: boolean }> = [];
    const call = (url: string) => {
      handler({ url, method: 'GET', resourceType: 'mainFrame', webContentsId: 1 }, (res: any) => {
        calls.push({ url, cancel: !!res.cancel });
      });
    };

    call('file:///C:/foo');
    call('app://index.html');
    call('chrome://newtab');
    call('devtools://devtools/bundled/inspector.html');
    call('https://evil.com/x');
    call('http://localhost/');
    call('ws://remote/');

    const byUrl = Object.fromEntries(calls.map((c) => [c.url, c.cancel]));
    expect(byUrl['file:///C:/foo']).toBe(false);
    expect(byUrl['app://index.html']).toBe(false);
    expect(byUrl['chrome://newtab']).toBe(false);
    expect(byUrl['devtools://devtools/bundled/inspector.html']).toBe(false);
    expect(byUrl['https://evil.com/x']).toBe(true);
    expect(byUrl['http://localhost/']).toBe(true);
    expect(byUrl['ws://remote/']).toBe(true);
  });

  it('denies every permission request and check', () => {
    expect(setPermissionHandler).toHaveBeenCalled();
    const permHandler = setPermissionHandler.mock.calls[0][0];
    const cb = vi.fn();
    permHandler({}, 'camera', cb);
    expect(cb).toHaveBeenCalledWith(false);

    const permCheck = setPermissionCheck.mock.calls[0][0];
    expect(permCheck()).toBe(false);
  });
});
