import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function IconButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type="button" className={['ui-icon-button', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </button>
  );
}
