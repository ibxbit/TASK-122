import { dialog, BrowserWindow, type SaveDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/* =========================================================================
 * Export-Destination Chooser
 *
 *  User-triggered exports (CSV / PDF / ZIP audit bundles) MUST let the user
 *  pick a destination.  This module centralises:
 *
 *    chooseExportDestination({ title, defaultPath, filters, requireDir })
 *      → null (user cancelled) | validated absolute path
 *
 *  Validation rules (fail-closed):
 *    • Path must be absolute after resolution
 *    • No path-traversal components (`..`) after normalisation
 *    • Parent directory must exist OR be the user-selected directory itself
 *    • File extension must match the requested kind (csv/pdf/zip)
 *    • For writes, the parent directory must be writable
 *
 *  The audit layer records every accepted destination so later reviewers can
 *  see where the bundle was written.  Cancellations are logged but not
 *  audited (no action was taken).
 * ========================================================================= */

export type ExportKind = 'csv' | 'pdf' | 'zip';

export interface ChooseOptions {
  title:         string;
  defaultName:   string;           // e.g. "audit_2026-04-17.zip"
  kind:          ExportKind;
  parentWindow?: BrowserWindow;
}

export interface ExportDestination {
  absolutePath: string;
  kind:         ExportKind;
}

const KIND_FILTERS: Record<ExportKind, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV',       extensions: ['csv'] },
  pdf: { name: 'PDF',       extensions: ['pdf'] },
  zip: { name: 'ZIP Bundle', extensions: ['zip'] },
};

export async function chooseExportDestination(
  opts: ChooseOptions,
): Promise<ExportDestination | null> {
  const dialogOpts: SaveDialogOptions = {
    title:         opts.title,
    defaultPath:   opts.defaultName,
    buttonLabel:   'Export',
    filters:       [KIND_FILTERS[opts.kind], { name: 'All Files', extensions: ['*'] }],
    properties:    ['showOverwriteConfirmation', 'createDirectory'],
  };

  const result = opts.parentWindow
    ? await dialog.showSaveDialog(opts.parentWindow, dialogOpts)
    : await dialog.showSaveDialog(dialogOpts);

  if (result.canceled || !result.filePath) {
    logger.info({ kind: opts.kind }, 'export_destination_cancelled');
    return null;
  }

  const validated = await validateDestination(result.filePath, opts.kind);
  return { absolutePath: validated, kind: opts.kind };
}

/** Programmatic validation, usable from tests without a dialog. */
export async function validateDestination(
  requestedPath: string,
  kind: ExportKind,
): Promise<string> {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new ExportDestinationError('empty_path');
  }

  // Resolve + normalise — rejects `..` escapes even if the user typed them.
  const abs = path.resolve(requestedPath);
  const normalised = path.normalize(abs);
  if (normalised !== abs) {
    throw new ExportDestinationError('non_canonical_path');
  }

  // Contains a .. component even after resolution? Disallow.
  if (abs.split(path.sep).some((seg) => seg === '..')) {
    throw new ExportDestinationError('traversal_component');
  }

  // Extension must match the requested kind (case-insensitive).
  const ext = path.extname(abs).toLowerCase().replace(/^\./, '');
  if (ext !== kind) {
    throw new ExportDestinationError('extension_mismatch', `.${ext} != .${kind}`);
  }

  // Parent directory must exist and be writable.
  const parent = path.dirname(abs);
  try {
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) throw new ExportDestinationError('parent_not_directory');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ExportDestinationError('parent_missing', parent);
    }
    throw err;
  }

  try { await fs.access(parent, fs.constants.W_OK); }
  catch { throw new ExportDestinationError('parent_not_writable', parent); }

  return abs;
}

export class ExportDestinationError extends Error {
  constructor(public readonly code: string, public readonly detail?: string) {
    super(`export_destination:${code}${detail ? `:${detail}` : ''}`);
    this.name = 'ExportDestinationError';
  }
}
