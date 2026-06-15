'use client';

import { useTheme } from '@/components/ThemeProvider';

export function BrandLogo() {
  const { resolved } = useTheme();
  const src = resolved === 'light' ? '/logos/tantalum-logo-light.svg' : '/logos/tantalum-logo-dark.svg';

  return <img src={src} alt="" width={28} height={28} />;
}
