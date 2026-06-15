import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  children: ReactNode;
};

function classNames(variant: ButtonVariant, size: ButtonSize, className?: string) {
  return ['ui-button', `ui-button--${variant}`, size === 'md' ? 'ui-button--md' : 'ui-button--sm', className]
    .filter(Boolean)
    .join(' ');
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  href,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  const classes = classNames(variant, size, className);

  if (href) {
    const isExternal = href.startsWith('http') || href.startsWith('tantalum:');
    if (isExternal) {
      return (
        <a href={href} className={classes}>
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }

  return (
    <button type={type} className={classes} {...props}>
      {children}
    </button>
  );
}
