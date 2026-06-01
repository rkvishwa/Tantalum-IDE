import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ConfirmDialog, type ConfirmDialogTone } from './ConfirmDialog';

export type ConfirmOptions = {
  title?: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
};

export type AlertOptions = {
  title?: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  tone?: ConfirmDialogTone;
};

type ConfirmRequest = ConfirmOptions & {
  kind: 'confirm';
  resolve: (value: boolean) => void;
};

type AlertRequest = AlertOptions & {
  kind: 'alert';
  resolve: () => void;
};

type DialogRequest = ConfirmRequest | AlertRequest;

type ConfirmContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  alert: (options: AlertOptions) => Promise<void>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

function defaultConfirmLabel(tone: ConfirmDialogTone | undefined) {
  return tone === 'danger' ? 'Delete' : 'Continue';
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [activeRequest, setActiveRequest] = useState<DialogRequest | null>(null);
  const queueRef = useRef<DialogRequest[]>([]);

  const pumpQueue = useCallback(() => {
    setActiveRequest((current) => {
      if (current) {
        return current;
      }
      return queueRef.current.shift() ?? null;
    });
  }, []);

  const enqueue = useCallback(
    (request: DialogRequest) => {
      queueRef.current.push(request);
      pumpQueue();
    },
    [pumpQueue],
  );

  const finishActiveRequest = useCallback(
    (handler: (request: DialogRequest) => void) => {
      setActiveRequest((current) => {
        if (!current) {
          return current;
        }
        handler(current);
        return null;
      });
      window.requestAnimationFrame(() => {
        pumpQueue();
      });
    },
    [pumpQueue],
  );

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        enqueue({
          kind: 'confirm',
          ...options,
          resolve,
        });
      }),
    [enqueue],
  );

  const alert = useCallback(
    (options: AlertOptions) =>
      new Promise<void>((resolve) => {
        enqueue({
          kind: 'alert',
          ...options,
          resolve,
        });
      }),
    [enqueue],
  );

  const contextValue = useMemo(() => ({ confirm, alert }), [alert, confirm]);

  useEffect(() => {
    if (!activeRequest) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      if (activeRequest.kind === 'confirm') {
        finishActiveRequest((request) => {
          if (request.kind === 'confirm') {
            request.resolve(false);
          }
        });
        return;
      }

      finishActiveRequest((request) => {
        if (request.kind === 'alert') {
          request.resolve();
        }
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeRequest, finishActiveRequest]);

  const tone = activeRequest?.tone ?? 'default';
  const title = activeRequest?.title ?? (activeRequest?.kind === 'alert' ? 'Notice' : 'Confirm');
  const confirmLabel = activeRequest?.confirmLabel ?? (activeRequest?.kind === 'alert' ? 'OK' : defaultConfirmLabel(tone));

  return (
    <ConfirmContext.Provider value={contextValue}>
      {children}
      <ConfirmDialog
        open={Boolean(activeRequest)}
        title={title}
        message={activeRequest?.message ?? ''}
        detail={activeRequest?.detail}
        tone={tone}
        confirmLabel={confirmLabel}
        cancelLabel={activeRequest?.kind === 'confirm' ? activeRequest.cancelLabel ?? 'Cancel' : undefined}
        mode={activeRequest?.kind === 'alert' ? 'alert' : 'confirm'}
        onConfirm={() => {
          finishActiveRequest((request) => {
            if (request.kind === 'confirm') {
              request.resolve(true);
              return;
            }
            request.resolve();
          });
        }}
        onCancel={() => {
          finishActiveRequest((request) => {
            if (request.kind === 'confirm') {
              request.resolve(false);
              return;
            }
            request.resolve();
          });
        }}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error('useConfirm must be used within ConfirmProvider.');
  }
  return context;
}
