export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'tantalum-site-theme';

export function resolveThemePreference(preference: ThemePreference): ResolvedTheme {
  if (preference === 'dark' || preference === 'light') {
    return preference;
  }

  if (typeof window === 'undefined') {
    return 'dark';
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') {
    return 'dark';
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'system' || stored === 'dark' || stored === 'light') {
    return stored;
  }

  return 'dark';
}

export function applyTheme(preference: ThemePreference) {
  const resolved = resolveThemePreference(preference);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}
