import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/* =========================================================================
 * Preload — exposes a narrow `window.leasehub` API to the renderer under
 * context isolation.  The renderer has NO direct access to ipcRenderer or
 * Node — every call is mediated here.
 *
 *  Surface area (locked down):
 *    invoke(channel, payload)    → ipcRenderer.invoke (async request/reply)
 *    on(channel, listener)       → ipcRenderer.on (returns unsubscribe fn)
 *    send(channel, payload)      → ipcRenderer.send (fire-and-forget; used by
 *                                  the renderer-side checkpoint heartbeat)
 *    window.kind                 → derived from ?window=<kind> argv flag
 * ========================================================================= */

type Listener = (...args: unknown[]) => void;

function getWindowKind(): 'dashboard' | 'contracts' | 'audit' {
  const arg = (process.argv ?? []).find((a) => a.startsWith('--lh-window='));
  const v   = arg?.split('=')[1];
  return v === 'contracts' || v === 'audit' ? v : 'dashboard';
}

const bridge = {
  kind: getWindowKind(),

  /** Async request/response.  Errors thrown by the main handler reject here. */
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(channel, payload);
  },

  /** Subscribe to broadcasts (shortcut events, checkpoint-restore). */
  on(channel: string, listener: Listener): () => void {
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  /** Fire-and-forget (primarily: checkpoint:provide). */
  send(channel: string, payload?: unknown): void {
    ipcRenderer.send(channel, payload);
  },
};

contextBridge.exposeInMainWorld('leasehub', bridge);

export type LeaseHubBridge = typeof bridge;
