import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* =========================================================================
 * files:pickImages handler — real execution-path tests.
 *
 *  The handler uses Electron's dialog.showOpenDialog to get file paths,
 *  then reads each file from disk and base64-encodes it.  We stub only
 *  the dialog (no real OS picker in CI) and let the filesystem + Node
 *  code paths run for real — same logic the user sees.
 * ========================================================================= */

// vi.hoisted guarantees the object reference is created before vi.mock
// factories run — and the mock factory below captures the same reference,
// so state mutations in tests are visible to the fake Electron module.
const S = vi.hoisted(() => ({
  handlers:        new Map<string, (event: unknown, payload: unknown) => unknown>(),
  nextDialogResult: { canceled: true } as { canceled?: boolean; filePaths?: string[] },
  dialogCalls:     0,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, payload: unknown) => unknown) =>
      S.handlers.set(ch, fn),
  },
  dialog: {
    showOpenDialog: async () => {
      S.dialogCalls += 1;
      return S.nextDialogResult;
    },
  },
  BrowserWindow: { fromWebContents: () => null },
}));

import { registerFilePickerHandlers } from '../../src/main/ipc/file-picker.handler';

function invoke(channel: string, payload: unknown = {}): unknown {
  const fn = S.handlers.get(channel);
  if (!fn) throw new Error(`no_handler_for:${channel}`);
  return fn({ sender: {} }, payload);
}

let tmp = '';
async function writeJpeg(name: string, sizeBytes: number): Promise<string> {
  const p = path.join(tmp, name);
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0xFF; buf[1] = 0xD8; buf[2] = 0xFF;
  await fs.writeFile(p, buf);
  return p;
}
async function writePng(name: string, sizeBytes: number): Promise<string> {
  const p = path.join(tmp, name);
  const buf = Buffer.alloc(sizeBytes);
  const magic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  magic.copy(buf);
  await fs.writeFile(p, buf);
  return p;
}

describe('files:pickImages — registerFilePickerHandlers', () => {
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lh-picker-'));
    S.handlers.clear();
    S.dialogCalls = 0;
    S.nextDialogResult = { canceled: true };
    registerFilePickerHandlers();
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('registers the files:pickImages channel', () => {
    expect(S.handlers.has('files:pickImages')).toBe(true);
  });

  it('returns { ok: true, files: [] } when the user cancels', async () => {
    S.nextDialogResult = { canceled: true, filePaths: [] };
    const r = await invoke('files:pickImages') as { ok: boolean; files: unknown[] };
    expect(r).toEqual({ ok: true, files: [] });
    expect(S.dialogCalls).toBe(1);
  });

  it('returns { ok: true, files: [] } when the dialog returns an empty list', async () => {
    S.nextDialogResult = { canceled: false, filePaths: [] };
    const r = await invoke('files:pickImages') as { ok: boolean; files: unknown[] };
    expect(r).toEqual({ ok: true, files: [] });
  });

  it('reads + base64-encodes every picked file (JPG + PNG)', async () => {
    const a = await writeJpeg('a.jpg', 128);
    const b = await writePng('b.png', 256);
    S.nextDialogResult = { canceled: false, filePaths: [a, b] };
    const r = await invoke('files:pickImages') as {
      ok: boolean;
      files: Array<{ name: string; mimeType: string; sizeBytes: number; base64: string }>;
    };
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(2);
    expect(r.files[0].name).toBe('a.jpg');
    expect(r.files[0].mimeType).toBe('image/jpeg');
    expect(r.files[0].sizeBytes).toBe(128);
    expect(r.files[0].base64.length).toBeGreaterThan(0);
    expect(r.files[1].mimeType).toBe('image/png');
    // base64 round-trips to the original bytes
    expect(Buffer.from(r.files[0].base64, 'base64').length).toBe(128);
    expect(Buffer.from(r.files[1].base64, 'base64').length).toBe(256);
  });

  it('recognises .jpeg extension as image/jpeg', async () => {
    const p = await writeJpeg('pic.jpeg', 64);
    S.nextDialogResult = { canceled: false, filePaths: [p] };
    const r = await invoke('files:pickImages') as {
      ok: boolean;
      files: Array<{ mimeType: string }>;
    };
    expect(r.files[0].mimeType).toBe('image/jpeg');
  });

  it('rejects more than 5 files with too_many_selected', async () => {
    const paths = [];
    for (let i = 0; i < 6; i++) paths.push(await writeJpeg(`a${i}.jpg`, 16));
    S.nextDialogResult = { canceled: false, filePaths: paths };
    const r = await invoke('files:pickImages') as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^too_many_selected:6/);
  });

  it('rejects a file over 5 MiB with too_large', async () => {
    const big = 5 * 1024 * 1024 + 1;
    const p = await writeJpeg('huge.jpg', big);
    S.nextDialogResult = { canceled: false, filePaths: [p] };
    const r = await invoke('files:pickImages') as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('too_large:huge.jpg');
  });

  it('rejects non-image extensions with bad_extension', async () => {
    const p = path.join(tmp, 'evil.gif');
    await fs.writeFile(p, Buffer.alloc(32));
    S.nextDialogResult = { canceled: false, filePaths: [p] };
    const r = await invoke('files:pickImages') as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad_extension:evil.gif');
  });

  it('reports read_failed when a path doesn\'t exist', async () => {
    S.nextDialogResult = {
      canceled: false,
      filePaths: [path.join(tmp, 'does-not-exist.png')],
    };
    const r = await invoke('files:pickImages') as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^read_failed:does-not-exist\.png$/);
  });

  it('short-circuits on the first offender — no partial files returned', async () => {
    const good    = await writeJpeg('good.jpg', 16);
    const notReal = path.join(tmp, 'ghost.png');
    S.nextDialogResult = { canceled: false, filePaths: [good, notReal] };
    const r = await invoke('files:pickImages') as { ok: boolean; files?: unknown[] };
    expect(r.ok).toBe(false);
    // files property is absent on the error path; it is not a partial array
    expect(r.files).toBeUndefined();
  });
});
