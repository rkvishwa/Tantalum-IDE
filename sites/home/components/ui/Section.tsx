import type { ReactNode } from 'react';

type SectionProps = {
  children: ReactNode;
  band?: boolean;
  accent?: boolean;
  className?: string;
  id?: string;
};

export function Section({ children, band, accent, className, id }: SectionProps) {
  const classes = [
    band ? 'band' : 'page',
    accent ? 'band band--accent' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={classes} id={id}>
      {band ? <div className="page band__inner">{children}</div> : children}
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="ui-eyebrow">{children}</p>;
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h1>{title}</h1>
        {description ? <p className="page-header__desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
