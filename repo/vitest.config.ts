import { defineConfig } from 'vitest/config';
import path from 'node:path';

/* =========================================================================
 * Vitest config — runs unit_tests/ and integration_tests/ through a Node
 * environment.  Electron is stubbed via vi.mock in individual test files.
 *
 *  Coverage thresholds are ENFORCED at ≥ 95 % for every metric (branches,
 *  functions, lines, statements) across the measured source tree.
 *  Type-declaration files and platform-only glue (preload shim, renderer
 *  bootstrap) are excluded from the set under measurement; every file
 *  that encodes product behaviour is included.
 * ========================================================================= */

export default defineConfig({
  test: {
    environment: 'node',
    globals:     false,
    include: [
      'unit_tests/**/*.test.{ts,tsx}',
      'integration_tests/**/*.test.{ts,tsx}',
    ],
    testTimeout: 20_000,
    setupFiles:  ['unit_tests/_helpers/setup.ts'],
    reporters:   ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include:  ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/preload/**',                 // context-isolation shim (browser shape)
        '**/*.d.ts',
        'src/renderer/main.ts',           // bootstrap wiring only
        'src/renderer/imgui/app.ts',      // real-UI frame loop, exercised via views
      ],
      thresholds: {
        lines:      95,
        branches:   95,
        functions:  95,
        statements: 95,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
