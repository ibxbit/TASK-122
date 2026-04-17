import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/* =========================================================================
 * Shortcut Configuration
 *
 *  Persists per-installation overrides of DEFAULT_SHORTCUTS accelerators.
 *  On startup: load → merge with defaults → validate → apply to the
 *  ShortcutManager + Electron menu.  On user change: validate → write.
 *
 *  File layout (JSON):
 *    userData/shortcuts.json
 *    {
 *      "version": 1,
 *      "overrides": {
 *        "search": "Ctrl+Shift+F",
 *        "export": "Ctrl+E"
 *      }
 *    }
 *
 *  Invariants enforced by applyOverrides() / saveShortcutConfig():
 *    • Only known shortcut ids are accepted.
 *    • Accelerators are non-empty strings.
 *    • No two shortcuts may share the same accelerator (conflict detection).
 *    • Resetting an override returns the shortcut to its default.
 * ========================================================================= */

export interface ShortcutConfig {
  version:   1;
  overrides: Record<string, string>;   // shortcut id → accelerator
}

export class ShortcutConfigError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(`shortcut_config:${code}${detail ? `:${detail}` : ''}`);
    this.name = 'ShortcutConfigError';
  }
}

const EMPTY_CONFIG: ShortcutConfig = { version: 1, overrides: {} };

export function configPath(): string {
  return path.join(app.getPath('userData'), 'shortcuts.json');
}

export async function loadShortcutConfig(pathOverride?: string): Promise<ShortcutConfig> {
  const p = pathOverride ?? configPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return normaliseConfig(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_CONFIG, overrides: {} };
    }
    logger.warn({ err }, 'shortcut_config_load_failed_defaults_used');
    return { ...EMPTY_CONFIG, overrides: {} };
  }
}

export async function saveShortcutConfig(
  config: ShortcutConfig, pathOverride?: string,
): Promise<void> {
  const normalised = normaliseConfig(config);
  const p = pathOverride ?? configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const fh  = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(normalised, null, 2), 'utf8');
    await fh.sync();
  } finally { await fh.close(); }
  await fs.rename(tmp, p);
}

function normaliseConfig(raw: unknown): ShortcutConfig {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CONFIG, overrides: {} };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ...EMPTY_CONFIG, overrides: {} };
  const overrides: Record<string, string> = {};
  if (r.overrides && typeof r.overrides === 'object') {
    for (const [k, v] of Object.entries(r.overrides as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim().length > 0) {
        overrides[k] = v.trim();
      }
    }
  }
  return { version: 1, overrides };
}

export interface ShortcutDefLike {
  id: string;
  accelerator: string;
}

export interface EffectiveShortcut {
  id:           string;
  accelerator:  string;
  overridden:   boolean;
}

/**
 * Combine the default definitions with the persisted overrides and return
 * the effective list.  Throws `ShortcutConfigError` on:
 *   - unknown id referenced by an override
 *   - duplicate accelerators across the effective set (conflict)
 */
export function applyOverrides<T extends ShortcutDefLike>(
  defaults: T[], config: ShortcutConfig,
): Array<T & { overridden: boolean }> {
  const byId = new Map(defaults.map((d) => [d.id, d]));

  // Reject unknown ids first — clearer error than a later duplicate check.
  for (const id of Object.keys(config.overrides)) {
    if (!byId.has(id)) throw new ShortcutConfigError('unknown_shortcut_id', id);
  }

  const merged: Array<T & { overridden: boolean }> = defaults.map((def) => {
    const override = config.overrides[def.id];
    if (override !== undefined && override.trim().length === 0) {
      throw new ShortcutConfigError('empty_accelerator', def.id);
    }
    return {
      ...def,
      accelerator: override ?? def.accelerator,
      overridden:  override !== undefined && override !== def.accelerator,
    };
  });

  // Conflict detection — no two shortcuts may share an accelerator.
  const seen = new Map<string, string>();
  for (const s of merged) {
    const key = normaliseAccelerator(s.accelerator);
    const prior = seen.get(key);
    if (prior) {
      throw new ShortcutConfigError(
        'accelerator_conflict',
        `${prior} and ${s.id} both resolve to "${s.accelerator}"`,
      );
    }
    seen.set(key, s.id);
  }
  return merged;
}

/** Compute a canonical form for conflict comparison: order of modifiers
 *  ignored, case-insensitive, aliases (CmdOrCtrl) unified. */
export function normaliseAccelerator(acc: string): string {
  const parts = acc
    .split('+').map((p) => p.trim().toLowerCase())
    .map((p) => p === 'cmd' || p === 'cmdorctrl' || p === 'command' ? 'ctrl' : p)
    .map((p) => p === 'option' ? 'alt' : p);
  const mods = parts.slice(0, -1).sort().join('+');
  const key  = parts[parts.length - 1];
  return mods ? `${mods}+${key}` : key;
}

/** Update a single override value + re-validate the full set.  Returns
 *  the new config if valid; throws `ShortcutConfigError` otherwise. */
export function setOverride<T extends ShortcutDefLike>(
  defaults: T[], config: ShortcutConfig, id: string, accelerator: string,
): ShortcutConfig {
  const next: ShortcutConfig = {
    version: 1,
    overrides: { ...config.overrides, [id]: accelerator },
  };
  applyOverrides(defaults, next);   // throws on error
  return next;
}

/** Remove an override (back to default).  If it wasn't set, no-op. */
export function clearOverride(config: ShortcutConfig, id: string): ShortcutConfig {
  if (!(id in config.overrides)) return config;
  const next: ShortcutConfig = {
    version: 1,
    overrides: { ...config.overrides },
  };
  delete next.overrides[id];
  return next;
}

/** Factory reset — drops every override. */
export function resetConfig(): ShortcutConfig {
  return { version: 1, overrides: {} };
}
