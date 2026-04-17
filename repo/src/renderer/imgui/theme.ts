/* =========================================================================
 * Dear ImGui Theme — color tokens (ImGuiCol_* equivalents)
 *
 *  The values mirror the slate-palette tokens documented in the UI
 *  architecture so product colours stay consistent across any backend.
 * ========================================================================= */

export interface ImGuiTheme {
  WindowBg:          string;
  ChildBg:           string;
  TitleBg:           string;
  TitleBgActive:     string;

  Text:              string;
  TextDim:           string;
  TextDisabled:      string;

  Border:            string;
  Separator:         string;

  FrameBg:           string;
  FrameBgHovered:    string;
  FrameBgActive:     string;

  Button:            string;
  ButtonHovered:     string;
  ButtonActive:      string;

  ButtonDanger:      string;
  ButtonDangerHover: string;
  ButtonAccent:      string;
  ButtonAccentHover: string;

  Header:            string;
  HeaderHovered:     string;
  HeaderActive:      string;

  TableHeader:       string;
  TableBorder:       string;
  TableRowAlt:       string;

  Ok:                string;
  Warn:              string;
  Fail:              string;
}

/** Dark theme (default). */
export const DARK_THEME: ImGuiTheme = {
  WindowBg:          '#0f172a',    // slate-900
  ChildBg:           '#020617',    // slate-950
  TitleBg:           '#020617',
  TitleBgActive:     '#0f172a',

  Text:              '#f1f5f9',    // slate-100
  TextDim:           '#94a3b8',    // slate-400
  TextDisabled:      '#475569',    // slate-600

  Border:            '#1e293b',    // slate-800
  Separator:         '#1e293b',

  FrameBg:           '#0b1322',
  FrameBgHovered:    '#152033',
  FrameBgActive:     '#1e2a42',

  Button:            '#1e293b',
  ButtonHovered:     '#334155',
  ButtonActive:      '#475569',

  ButtonDanger:      '#dc2626',    // red-600
  ButtonDangerHover: '#ef4444',
  ButtonAccent:      '#0284c7',    // sky-600
  ButtonAccentHover: '#0ea5e9',

  Header:            '#1e293b',
  HeaderHovered:     '#334155',
  HeaderActive:      '#475569',

  TableHeader:       '#1e293b',
  TableBorder:       '#1e293b',
  TableRowAlt:       '#0b1322',

  Ok:                '#047857',
  Warn:              '#d97706',
  Fail:              '#b91c1c',
};

export const DEFAULT_FONT  = '13px "Segoe UI", system-ui, -apple-system, sans-serif';
export const MONO_FONT     = '12px Consolas, "Cascadia Mono", monospace';
export const HEADING_FONT  = '15px "Segoe UI", system-ui, sans-serif';
