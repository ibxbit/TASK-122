import { describe, it, expect } from 'vitest';
import { DARK_THEME, DEFAULT_FONT, MONO_FONT, HEADING_FONT, type ImGuiTheme } from '../../src/renderer/imgui/theme';

/* =========================================================================
 * Theme completeness — replaces MV-7 "visual design tokens" manual step.
 *
 *  Every ImGuiCol_-equivalent token is required by at least one widget
 *  in src/renderer/imgui/widgets.ts.  If any of them were ever to drop to
 *  undefined or an invalid string, the widget call `fillStyle = token`
 *  would set fillStyle to 'undefined' (a no-op in Canvas 2D) — the button
 *  would render as an invisible hit-box.  This test catches that before
 *  it ships.
 * ========================================================================= */

const REQUIRED_COLOUR_TOKENS: Array<keyof ImGuiTheme> = [
  'WindowBg', 'ChildBg', 'TitleBg', 'TitleBgActive',
  'Text', 'TextDim', 'TextDisabled',
  'Border', 'Separator',
  'FrameBg', 'FrameBgHovered', 'FrameBgActive',
  'Button', 'ButtonHovered', 'ButtonActive',
  'ButtonDanger', 'ButtonDangerHover',
  'ButtonAccent', 'ButtonAccentHover',
  'Header', 'HeaderHovered', 'HeaderActive',
  'TableHeader', 'TableBorder', 'TableRowAlt',
  'Ok', 'Warn', 'Fail',
];

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

describe('Dear ImGui theme contract', () => {
  it('every required colour token is present as a valid CSS hex', () => {
    for (const key of REQUIRED_COLOUR_TOKENS) {
      const value = DARK_THEME[key];
      expect(value, `token ${String(key)} must be a string`).toBeTypeOf('string');
      expect(value, `token ${String(key)} must be hex`).toMatch(HEX_RE);
    }
  });

  it('has no unexpected keys (guards against rot)', () => {
    const actualKeys = new Set(Object.keys(DARK_THEME));
    const expected   = new Set<string>(REQUIRED_COLOUR_TOKENS as string[]);
    for (const k of actualKeys) {
      expect(expected.has(k), `unexpected theme key: ${k}`).toBe(true);
    }
  });

  it('destructive and accent colours are distinct from the default button', () => {
    expect(DARK_THEME.ButtonDanger).not.toBe(DARK_THEME.Button);
    expect(DARK_THEME.ButtonAccent).not.toBe(DARK_THEME.Button);
    expect(DARK_THEME.ButtonDanger).not.toBe(DARK_THEME.ButtonAccent);
  });

  it('status colours (ok / warn / fail) are distinct', () => {
    const s = new Set([DARK_THEME.Ok, DARK_THEME.Warn, DARK_THEME.Fail]);
    expect(s.size).toBe(3);
  });

  it('font tokens include size + family and are non-empty strings', () => {
    for (const [name, token] of [['DEFAULT', DEFAULT_FONT], ['MONO', MONO_FONT], ['HEADING', HEADING_FONT]] as const) {
      expect(token, `${name} font must be a non-empty string`).toMatch(/\d+\s*px/);
      expect(token.length).toBeGreaterThan(4);
    }
  });
});
