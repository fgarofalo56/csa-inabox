'use client';

import { Button, tokens } from '@fluentui/react-components';
import { WeatherSunny24Regular, WeatherMoon24Regular } from '@fluentui/react-icons';
import { useTheme } from '@/lib/theme/theme-context';

export function ThemeToggle({ color }: { color?: string }) {
  const { mode, toggle } = useTheme();
  return (
    <Button
      appearance="transparent"
      icon={mode === 'dark' ? <WeatherSunny24Regular /> : <WeatherMoon24Regular />}
      onClick={toggle}
      aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={mode === 'dark' ? 'Light theme' : 'Dark theme'}
      style={{ color: color ?? tokens.colorNeutralForeground1 }}
    />
  );
}
