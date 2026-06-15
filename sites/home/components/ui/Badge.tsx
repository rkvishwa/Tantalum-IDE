type BadgeVariant = 'default' | 'success' | 'warning' | 'danger';

export function Badge({ children, variant = 'default' }: { children: React.ReactNode; variant?: BadgeVariant }) {
  const className = variant === 'default' ? 'ui-badge' : `ui-badge ui-badge--${variant}`;
  return <span className={className}>{children}</span>;
}
