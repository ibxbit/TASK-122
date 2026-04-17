/* =========================================================================
 * DB module barrel — re-exports cleanup's singleton helpers so that callers
 * can `import { getDb } from '../db'` without knowing about the internal
 * file layout.  Schemas live under ./schema, migrations under ./migrations.
 * ========================================================================= */

export { getDb, getDbLifecycle, initDbLifecycle, hasDbLifecycle, DbLifecycle, resetDbLifecycleForTests } from './cleanup';
export type { DbLifecycleDeps } from './cleanup';
