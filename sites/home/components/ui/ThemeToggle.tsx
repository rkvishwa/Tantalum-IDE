'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import type { ThemePreference } from '@/lib/theme';

const options: Array<{ value: ThemePreference; label: string; icon: typeof Monitor }> = [
  { value: 'system', label: 'System theme', icon: Monitor },
  { value: 'dark', label: 'Dark theme', icon: Moon },
  { value: 'light', label: 'Light theme', icon: Sun },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="segmented-control" role="group" aria-label="Theme">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className={preference === value ? 'active' : ''}
          aria-label={label}
          aria-pressed={preference === value}
          onClick={() => setPreference(value)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
