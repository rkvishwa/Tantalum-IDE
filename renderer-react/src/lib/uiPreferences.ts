export type ThemePreference = 'system' | 'dark' | 'light';

export type UiPreferences = {
  theme: ThemePreference;
  fontFamily: string;
  fontSize: number;
  accentColor: string;
  editorFontFamily: string;
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: 'off' | 'on';
  editorMinimap: boolean;
  editorLineNumbers: 'on' | 'relative' | 'off';
  editorQuickSuggestions: boolean;
  editorInlineSuggest: boolean;
  editorInlayHints: boolean;
  editorCodeLens: boolean;
  editorStickyScroll: boolean;
  editorFormatOnType: boolean;
  editorFormatOnPaste: boolean;
  editorBracketPairs: boolean;
  editorAutoSave: boolean;
  verifyBeforeUpload: boolean;
  sourceSnapshotsEnabled: boolean;
};

const LEGACY_VS_CODE_FONT_FAMILY = "'Segoe WPC', 'Segoe UI', system-ui, sans-serif";

export const SYSTEM_FONT_FAMILY = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
export const VS_CODE_FONT_FAMILY = "'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
export const VS_CODE_MONO_FONT_FAMILY = "Consolas, 'Courier New', monospace";
export const SYSTEM_MONO_FONT_FAMILY = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Courier New', monospace";

export const FONT_FAMILY_OPTIONS = [
  { label: 'System default', value: SYSTEM_FONT_FAMILY },
  { label: 'System monospace', value: SYSTEM_MONO_FONT_FAMILY },
  { label: 'Segoe UI', value: "'Segoe UI', system-ui, sans-serif" },
  { label: 'Consolas', value: VS_CODE_MONO_FONT_FAMILY },
  { label: 'Cascadia Code', value: "'Cascadia Code', Consolas, monospace" },
  { label: 'Arial', value: "Arial, 'Segoe UI', sans-serif" },
];

export const ACCENT_PRESETS = ['#0078d4', '#3794ff', '#c586c0', '#4ec9b0', '#d7ba7d', '#f14c4c'];

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: 'system',
  fontFamily: SYSTEM_FONT_FAMILY,
  fontSize: 13,
  accentColor: '#0078d4',
  editorFontFamily: SYSTEM_MONO_FONT_FAMILY,
  editorFontSize: 14,
  editorTabSize: 2,
  editorWordWrap: 'off',
  editorMinimap: true,
  editorLineNumbers: 'on',
  editorQuickSuggestions: true,
  editorInlineSuggest: true,
  editorInlayHints: true,
  editorCodeLens: true,
  editorStickyScroll: true,
  editorFormatOnType: true,
  editorFormatOnPaste: true,
  editorBracketPairs: true,
  editorAutoSave: false,
  verifyBeforeUpload: true,
  sourceSnapshotsEnabled: true,
};

const STORAGE_KEY = 'tantalum-ui-preferences';

export function resolveThemePreference(theme: ThemePreference) {
  if (theme !== 'system') {
    return theme;
  }

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function loadUiPreferences(): UiPreferences {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_UI_PREFERENCES;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_UI_PREFERENCES;
    }

    const parsed = JSON.parse(stored) as Partial<UiPreferences>;
    return normalizeUiPreferences(parsed);
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

export function saveUiPreferences(preferences: UiPreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function normalizeUiPreferences(preferences: Partial<UiPreferences>): UiPreferences {
  const theme = preferences.theme === 'dark' || preferences.theme === 'light' || preferences.theme === 'system' ? preferences.theme : DEFAULT_UI_PREFERENCES.theme;
  const fontSize = Number.isFinite(preferences.fontSize) ? clamp(Number(preferences.fontSize), 11, 18) : DEFAULT_UI_PREFERENCES.fontSize;
  const editorFontSize = Number.isFinite(preferences.editorFontSize)
    ? clamp(Number(preferences.editorFontSize), 10, 24)
    : DEFAULT_UI_PREFERENCES.editorFontSize;
  const editorTabSize = Number.isFinite(preferences.editorTabSize)
    ? clamp(Number(preferences.editorTabSize), 2, 8)
    : DEFAULT_UI_PREFERENCES.editorTabSize;
  const fontFamily =
    typeof preferences.fontFamily === 'string' &&
    preferences.fontFamily.trim() &&
    preferences.fontFamily !== LEGACY_VS_CODE_FONT_FAMILY &&
    preferences.fontFamily !== VS_CODE_FONT_FAMILY
      ? preferences.fontFamily
      : DEFAULT_UI_PREFERENCES.fontFamily;
  const editorFontFamily =
    typeof preferences.editorFontFamily === 'string' &&
    preferences.editorFontFamily.trim() &&
    preferences.editorFontFamily !== VS_CODE_MONO_FONT_FAMILY
      ? preferences.editorFontFamily
      : DEFAULT_UI_PREFERENCES.editorFontFamily;
  const accentColor = typeof preferences.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(preferences.accentColor)
    ? preferences.accentColor
    : DEFAULT_UI_PREFERENCES.accentColor;
  const editorWordWrap = preferences.editorWordWrap === 'on' || preferences.editorWordWrap === 'off'
    ? preferences.editorWordWrap
    : DEFAULT_UI_PREFERENCES.editorWordWrap;
  const editorLineNumbers =
    preferences.editorLineNumbers === 'on' || preferences.editorLineNumbers === 'relative' || preferences.editorLineNumbers === 'off'
      ? preferences.editorLineNumbers
      : DEFAULT_UI_PREFERENCES.editorLineNumbers;

  return {
    theme,
    fontFamily,
    fontSize,
    accentColor,
    editorFontFamily,
    editorFontSize,
    editorTabSize,
    editorWordWrap,
    editorMinimap: typeof preferences.editorMinimap === 'boolean' ? preferences.editorMinimap : DEFAULT_UI_PREFERENCES.editorMinimap,
    editorLineNumbers,
    editorQuickSuggestions: typeof preferences.editorQuickSuggestions === 'boolean' ? preferences.editorQuickSuggestions : DEFAULT_UI_PREFERENCES.editorQuickSuggestions,
    editorInlineSuggest: typeof preferences.editorInlineSuggest === 'boolean' ? preferences.editorInlineSuggest : DEFAULT_UI_PREFERENCES.editorInlineSuggest,
    editorInlayHints: typeof preferences.editorInlayHints === 'boolean' ? preferences.editorInlayHints : DEFAULT_UI_PREFERENCES.editorInlayHints,
    editorCodeLens: typeof preferences.editorCodeLens === 'boolean' ? preferences.editorCodeLens : DEFAULT_UI_PREFERENCES.editorCodeLens,
    editorStickyScroll: typeof preferences.editorStickyScroll === 'boolean' ? preferences.editorStickyScroll : DEFAULT_UI_PREFERENCES.editorStickyScroll,
    editorFormatOnType: typeof preferences.editorFormatOnType === 'boolean' ? preferences.editorFormatOnType : DEFAULT_UI_PREFERENCES.editorFormatOnType,
    editorFormatOnPaste: typeof preferences.editorFormatOnPaste === 'boolean' ? preferences.editorFormatOnPaste : DEFAULT_UI_PREFERENCES.editorFormatOnPaste,
    editorBracketPairs: typeof preferences.editorBracketPairs === 'boolean' ? preferences.editorBracketPairs : DEFAULT_UI_PREFERENCES.editorBracketPairs,
    editorAutoSave: typeof preferences.editorAutoSave === 'boolean' ? preferences.editorAutoSave : DEFAULT_UI_PREFERENCES.editorAutoSave,
    verifyBeforeUpload: typeof preferences.verifyBeforeUpload === 'boolean' ? preferences.verifyBeforeUpload : DEFAULT_UI_PREFERENCES.verifyBeforeUpload,
    sourceSnapshotsEnabled: typeof preferences.sourceSnapshotsEnabled === 'boolean' ? preferences.sourceSnapshotsEnabled : DEFAULT_UI_PREFERENCES.sourceSnapshotsEnabled,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getAccentContrastColor(accentColor: string) {
  const hex = accentColor.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return '#ffffff';
  }

  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const yiq = (red * 299 + green * 587 + blue * 114) / 1000;

  return yiq >= 150 ? '#081018' : '#ffffff';
}

export type ResolvedTheme = 'light' | 'dark';

export function applyDocumentTheme(preferences: UiPreferences): ResolvedTheme {
  const resolved = resolveThemePreference(preferences.theme);
  const root = document.documentElement;

  root.dataset.theme = resolved;
  root.dataset.themePreference = preferences.theme;
  root.style.setProperty('--app-font-family', preferences.fontFamily);
  root.style.setProperty('--app-font-size', `${preferences.fontSize}px`);
  root.style.setProperty('--accent', preferences.accentColor);
  root.style.setProperty('--accent-contrast', getAccentContrastColor(preferences.accentColor));
  root.style.setProperty('--color-accent', preferences.accentColor);

  return resolved;
}
