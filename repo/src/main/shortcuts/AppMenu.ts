import { Menu, type MenuItemConstructorOptions } from 'electron';
import { windowManager } from '../windows/WindowManager';
import {
  shortcutManager, broadcastToFocused, type ShortcutDef,
} from './ShortcutManager';
import { applyOverrides, type ShortcutConfig } from './config';

/* =========================================================================
 * AppMenu — thin layer that plugs ShortcutManager into the Electron menu.
 *
 *  The three product-required shortcuts live in DEFAULT_SHORTCUTS.  The
 *  actual live set after bootstrap is DEFAULT_SHORTCUTS ↺ `shortcuts.json`
 *  overrides (if any); the config layer rejects conflicts before they
 *  reach the menu.
 * ========================================================================= */

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  {
    id:          'search',
    label:       'Global Search…',
    accelerator: 'Ctrl+K',
    group:       'go',
    handler:     broadcastToFocused('shortcut:search'),
  },
  {
    id:          'export',
    label:       'Export…',
    accelerator: 'Ctrl+E',
    group:       'file',
    handler:     broadcastToFocused('shortcut:export'),
  },
  {
    id:          'audit',
    label:       'Audit Log',
    accelerator: 'Ctrl+Shift+L',
    group:       'go',
    handler:     () => { windowManager.open('audit'); },
  },
];

/** Merge DEFAULT_SHORTCUTS with the persisted config (overriding the
 *  accelerator field only) and register the result into ShortcutManager. */
export function buildAppMenu(config?: ShortcutConfig): void {
  const effective = config
    ? applyOverrides(DEFAULT_SHORTCUTS, config)
    : DEFAULT_SHORTCUTS.map((d) => ({ ...d, overridden: false }));

  // Clear any prior registrations so repeat calls (e.g. after the user
  // saves a new config) reflect the latest accelerator bindings.
  for (const s of shortcutManager.list()) shortcutManager.unregister(s.id);
  shortcutManager.registerAll(effective);

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        ...shortcutManager.asMenuItems('file'),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        ...shortcutManager.asMenuItems('go'),
        { type: 'separator' },
        { label: 'Dashboard',          click: () => windowManager.open('dashboard') },
        { label: 'Contract Workspace', click: () => windowManager.open('contracts') },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...shortcutManager.asMenuItems('view'),
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
