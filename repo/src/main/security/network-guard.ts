import { app, session, type Session } from 'electron';
import { logger } from '../logger';

/* =========================================================================
 * Offline Network Guard
 *
 *   Global enforcement via session.webRequest.onBeforeRequest.
 *
 *   ALLOW  : file://  app://
 *   ALLOW  : Chromium-internal schemes (chrome://, devtools://, chrome-
 *            extension://) — never network-backed and required for the
 *            renderer / DevTools to function.
 *   ALLOW  : VITE_DEV_SERVER_URL in development only (gated by env var;
 *            production bundles never observe this path).
 *   BLOCK  : every other URL — http(s), ws(s), external redirects, etc.
 *
 *   Installation attaches to:
 *     • session.defaultSession
 *     • every future partition session (`app.on('session-created')`)
 *
 *   onBeforeRequest also fires for each redirect hop, so a 302 → external
 *   host is caught and cancelled.
 * ========================================================================= */

const ALLOWED_PREFIXES = [
  'file://',
  'app://',
  'chrome://',                  // Chromium internals (new-tab, PDF viewer, etc.)
  'devtools://',
  'chrome-devtools://',
  'chrome-extension://',        // devtools extensions (React DevTools, etc.)
] as const;

export function installNetworkGuard(): void {
  attach(session.defaultSession);
  app.on('session-created', (s) => attach(s));
  logger.info({ allow: ALLOWED_PREFIXES }, 'network_guard_installed');
}

function attach(s: Session): void {
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isAllowed(details.url)) {
      callback({ cancel: false });
      return;
    }
    logger.warn(
      {
        url:           details.url,
        method:        details.method,
        resourceType:  details.resourceType,
        webContentsId: details.webContentsId,
      },
      'network_blocked',
    );
    callback({ cancel: true });
  });

  // Browser-API permission surfaces (geolocation, notifications, media, …) —
  // deny every request, deny every check.  Keeps the render process from
  // even attempting to ask a user.
  s.setPermissionRequestHandler((_wc, permission, callback) => {
    logger.info({ permission }, 'permission_denied');
    callback(false);
  });
  s.setPermissionCheckHandler(() => false);

  // No proxies — a misconfigured system proxy could otherwise tunnel traffic
  // before webRequest sees it.
  s.setProxy({ mode: 'direct' }).catch((err) => {
    logger.warn({ err }, 'network_guard_set_proxy_failed');
  });
}

function isAllowed(url: string): boolean {
  for (const p of ALLOWED_PREFIXES) {
    if (url.startsWith(p)) return true;
  }
  // Dev-server carve-out — production is not exposed to this branch because
  // VITE_DEV_SERVER_URL is only set by the dev entrypoint.
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev && url.startsWith(dev)) return true;
  return false;
}
