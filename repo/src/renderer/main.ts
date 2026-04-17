import { bootImGuiApp, type WindowKind, type IpcBridge } from './imgui/app';
import './index.css';

/* =========================================================================
 * Renderer Entrypoint — Dear ImGui production UI.
 *
 *  All three BrowserWindow variants load this same entry.  The main-process
 *  WindowManager appends ?window=<kind> and (via preload) --lh-window so the
 *  renderer routes to the matching view.  There is NO React runtime and no
 *  virtual DOM — every pixel is drawn by the immediate-mode framework in
 *  src/renderer/imgui/.
 * ========================================================================= */

function readWindowKind(): WindowKind {
  const q = new URLSearchParams(window.location.search).get('window');
  if (q === 'contracts' || q === 'audit' || q === 'reviews' ||
      q === 'routing'  || q === 'admin' || q === 'settings') {
    return q;
  }
  return 'dashboard';
}

const canvas = document.getElementById('imgui-canvas') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('imgui_canvas_missing');
}

// Safely acquire the preload bridge.  In renderer tests/offline boot where
// the bridge hasn't been injected (e.g. Vite dev server), fall back to a
// stub that rejects every invoke with a clear error so IPC failures surface
// loudly instead of producing phantom-success UIs.
const bridge: IpcBridge = ((window as unknown as { leasehub?: IpcBridge }).leasehub) ?? {
  invoke: (_ch: string) => Promise.reject(new Error('ipc_bridge_not_available')),
  on:     () => () => {},
  send:   () => {},
  kind:   readWindowKind(),
};

bootImGuiApp(canvas, bridge, readWindowKind());
