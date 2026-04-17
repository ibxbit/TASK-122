/* =========================================================================
 * Vitest global setup — runs ONCE before all tests in the run.
 *  - Silences noisy stdout from pino (tests can still inspect via mocks)
 *  - Sets hermetic env vars so modules that read them behave predictably
 * ========================================================================= */

process.env.NODE_ENV     = process.env.NODE_ENV     ?? 'test';
process.env.LH_LOG_LEVEL = process.env.LH_LOG_LEVEL ?? 'silent';
process.env.LH_USER_DATA = process.env.LH_USER_DATA ?? require('node:os').tmpdir();
process.env.LH_LOGS_DIR  = process.env.LH_LOGS_DIR  ?? require('node:os').tmpdir();
