type BannerVariant = 'info' | 'warning' | 'error' | 'success';

export function Banner({ children, variant = 'info' }: { children: React.ReactNode; variant?: BannerVariant }) {
  return <div className={`ui-banner ui-banner--${variant}`}>{children}</div>;
}
