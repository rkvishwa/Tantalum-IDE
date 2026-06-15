import { useEffect, useState } from 'react';

import {
  applyDocumentTheme,
  loadUiPreferences,
  resolveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
  type UiPreferences,
} from '@/lib/uiPreferences';

export function useDocumentTheme(preferences?: UiPreferences) {
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveThemePreference((preferences ?? loadUiPreferences()).theme),
  );

  useEffect(() => {
    const activePreferences = preferences ?? loadUiPreferences();
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');

    const apply = () => {
      setResolvedTheme(applyDocumentTheme(activePreferences));
    };

    apply();

    const handleSystemThemeChange = () => {
      if (activePreferences.theme === 'system') {
        apply();
      }
    };

    mediaQuery.addEventListener('change', handleSystemThemeChange);

    return () => {
      mediaQuery.removeEventListener('change', handleSystemThemeChange);
    };
  }, [preferences]);

  return resolvedTheme;
}

export function useBootDocumentTheme() {
  useDocumentTheme();
}

export function useThemePreferenceListener(themePreference: ThemePreference, onChange: () => void) {
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');

    const handleChange = () => {
      if (themePreference === 'system') {
        onChange();
      }
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [onChange, themePreference]);
}
