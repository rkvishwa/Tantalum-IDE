import type { ReactNode } from 'react';

type ModalProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  backdropClassName?: string;
  cardClassName?: string;
  showHeader?: boolean;
};

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  size = 'md',
  backdropClassName,
  cardClassName,
  showHeader = true,
}: ModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className={`modal-backdrop ${backdropClassName || ''}`.trim()} onClick={onClose} role="presentation">
      <div
        className={`modal-card modal-${size} ${cardClassName || ''}`.trim()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={showHeader ? undefined : title}
      >
        {showHeader ? (
          <>
            <div className="modal-header">
              <div>
                <h2>{title}</h2>
                {subtitle ? <p>{subtitle}</p> : null}
              </div>
              <button className="ghost-button" type="button" onClick={onClose} aria-label={`Close ${title}`}>
                Close
              </button>
            </div>
            <div className="modal-body">{children}</div>
          </>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
