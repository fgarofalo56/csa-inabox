'use client';

/**
 * Theme system — persistent light/dark switcher wired through
 * FluentProvider. Uses localStorage + matches prefers-color-scheme on
 * first paint. Adds a CSS data-theme attribute on <html> so global
 * styles (gradients, custom colors) can branch on theme.
 */

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { FluentProvider, webLightTheme, webDarkTheme, Theme } from '@fluentui/react-components';

export type ThemeMode = 'light' | 'dark';

interface ThemeCtx {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx>({ mode: 'light', setMode: () => {}, toggle: () => {} });
export const useTheme = () => useContext(Ctx);

const STORAGE_KEY = 'loom.theme';

/**
 * Brand-extended Fluent themes — overrides the brand ramp so Loom
 * accents (indigo→blue→amber) come through buttons, links, badges,
 * focus rings, etc.
 *
 * Fluent v9 expects the brand colors as ColorTokens; we override
 * just enough to land the CSA Loom palette without breaking contrast.
 */
function brandedLight(): Theme {
  return {
    ...webLightTheme,
    colorBrandBackground:        '#3d2e80',
    colorBrandBackgroundHover:   '#322369',
    colorBrandBackgroundPressed: '#241749',
    colorBrandBackground2:       '#ece8fa',
    colorBrandBackground2Hover:  '#dcd4f4',
    colorBrandForeground1:       '#3d2e80',
    colorBrandForeground2:       '#322369',
    colorBrandForegroundLink:    '#3d2e80',
    colorBrandStroke1:           '#3d2e80',
  };
}
function brandedDark(): Theme {
  return {
    ...webDarkTheme,
    colorBrandBackground:        '#7d6cff',
    colorBrandBackgroundHover:   '#9988ff',
    colorBrandBackgroundPressed: '#5d4ce6',
    colorBrandBackground2:       '#1a1342',
    colorBrandBackground2Hover:  '#241749',
    colorBrandForeground1:       '#aea0ff',
    colorBrandForeground2:       '#c8baff',
    colorBrandForegroundLink:    '#aea0ff',
    colorBrandStroke1:           '#7d6cff',
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('light');

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) as ThemeMode | null : null;
    const initial: ThemeMode = stored
      ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setModeState(initial);
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', mode);
    }
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
  }, []);
  const toggle = useCallback(() => setMode(mode === 'light' ? 'dark' : 'light'), [mode, setMode]);

  const theme = mode === 'dark' ? brandedDark() : brandedLight();

  return (
    <Ctx.Provider value={{ mode, setMode, toggle }}>
      <FluentProvider theme={theme}>{children}</FluentProvider>
    </Ctx.Provider>
  );
}
