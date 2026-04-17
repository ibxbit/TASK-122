import { defineConfig } from 'vite';
import path from 'node:path';

/* =========================================================================
 * Vite renderer config — single entry shared by all BrowserWindow variants.
 * The renderer is a Dear ImGui-style immediate-mode UI drawn to Canvas 2D;
 * there is no React / JSX pipeline.  Main + preload are compiled via
 * `tsc -p tsconfig.main.json`, not Vite.
 * ========================================================================= */

export default defineConfig({
  root: 'src/renderer',
  build: {
    outDir:       path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir:  true,
    target:       'chrome120',
    sourcemap:    true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
