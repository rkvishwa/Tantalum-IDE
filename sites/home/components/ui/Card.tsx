import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type CardProps = {
  children: ReactNode;
  icon?: LucideIcon;
  title?: string;
  className?: string;
  style?: CSSProperties;
  large?: boolean;
};

export function Card({ children, icon: Icon, title, className, style, large }: CardProps) {
  return (
    <article
      className={['ui-card', large ? 'ui-card--lg' : '', className].filter(Boolean).join(' ')}
      style={style}
    >
      {Icon || title ? (
        <div className="ui-card__header">
          {Icon ? <Icon size={16} /> : null}
          {title ? <h3>{title}</h3> : null}
        </div>
      ) : null}
      {children}
    </article>
  );
}
