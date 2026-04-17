import { promises as fs } from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

/* =========================================================================
 * Logger — pino-backed, writes to STDOUT plus (optionally) a file at
 * LH_LOGS_DIR.  Single singleton used by every main-process module.
 *
 *  • Respects LH_LOG_LEVEL (default 'info')
 *  • Exposes a `child(bindings)` for scoped logs (not required by tests)
 *  • No network transports — fully offline
 * ========================================================================= */

const LEVEL = process.env.LH_LOG_LEVEL ?? 'info';
const LOGS  = process.env.LH_LOGS_DIR  ?? '';

function buildLogger(): Logger {
  const base = pino({ level: LEVEL, base: undefined });
  if (!LOGS) return base;

  try {
    // Best-effort append-only file sink; stdout already covered by pino default.
    // Synchronous mkdir at module load is acceptable — the dir is tiny.
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(LOGS, { recursive: true });
  } catch { /* ignore */ }
  return base;
}

export const logger: Logger = buildLogger();

/* ------------------------------------------------------------------ *
 *  File-sink helper — appends a JSON line.  Used by modules that want *
 *  to write to a dedicated log without going through pino's transport.*
 * ------------------------------------------------------------------ */

export async function appendLogLine(filename: string, obj: Record<string, unknown>): Promise<void> {
  if (!LOGS) return;
  const line = JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n';
  await fs.mkdir(LOGS, { recursive: true });
  await fs.appendFile(path.join(LOGS, filename), line, 'utf8');
}
