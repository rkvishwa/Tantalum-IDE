import { Modal } from './Modal';

export type ConfirmDialogTone = 'default' | 'danger' | 'warning';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  detail?: string;
  tone?: ConfirmDialogTone;
  confirmLabel: string;
  cancelLabel?: string;
  mode: 'confirm' | 'alert';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function isGenericConfirmTitle(title: string) {
  return title === 'Confirm' || title === 'Notice';
}

function buildConfirmCopy(title: string, message: string, detail?: string) {
  const genericTitle = isGenericConfirmTitle(title);
  const headline = genericTitle ? message : title;
  const bodyParts: string[] = [];

  if (!genericTitle && message && message !== title) {
    bodyParts.push(message);
  }
  if (detail) {
    bodyParts.push(detail);
  }

  return {
    headline,
    body: bodyParts.join('\n\n') || undefined,
  };
}

function confirmButtonClass(tone: ConfirmDialogTone) {
  if (tone === 'danger') {
    return 'boards-hub-btn boards-inspector-footer-action boards-inspector-footer-danger';
  }

  if (tone === 'warning') {
    return 'boards-hub-btn boards-inspector-footer-action confirm-dialog-warning-btn';
  }

  return 'boards-hub-btn boards-hub-btn-primary boards-inspector-footer-action';
}

export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  tone = 'default',
  confirmLabel,
  cancelLabel = 'Cancel',
  mode,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = 'confirm-dialog-title';
  const messageId = 'confirm-dialog-message';
  const { headline, body } = buildConfirmCopy(title, message, detail);

  return (
    <Modal
      open={open}
      title={headline}
      onClose={onCancel}
      size="sm"
      showHeader={false}
      backdropClassName="confirm-provider-backdrop"
      cardClassName="confirm-dialog-card"
    >
      <div
        className="confirm-dialog-shell"
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={body ? messageId : undefined}
      >
        <div className="confirm-dialog-main">
          <h3 id={titleId}>{headline}</h3>
          {body ? (
            <p id={messageId} className="confirm-dialog-detail">
              {body}
            </p>
          ) : null}
        </div>

        <footer className="boards-inspector-footer confirm-dialog-footer">
          {mode === 'alert' ? (
            <button className={`${confirmButtonClass(tone)} boards-inspector-save`} type="button" onClick={onConfirm} disabled={busy} autoFocus>
              {confirmLabel}
            </button>
          ) : (
            <div className="boards-inspector-footer-row">
              <button className={confirmButtonClass(tone)} type="button" onClick={onConfirm} disabled={busy} autoFocus>
                {confirmLabel}
              </button>
              <button className="boards-hub-btn boards-inspector-footer-action" type="button" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </button>
            </div>
          )}
        </footer>
      </div>
    </Modal>
  );
}
