import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CircleStop, LoaderCircle, RefreshCcw, SearchX } from 'lucide-react';

import type { SerialPortBlocker } from '@/types/electron';

import { Modal } from './Modal';

type SerialPortBlockerDialogProps = {
  open: boolean;
  port: string;
  title?: string;
  subtitle?: string;
  retryLabel?: string;
  onClose: () => void;
  onRetry?: () => void;
};

function blockerActionLabel(blocker: SerialPortBlocker) {
  return blocker.kind === 'tantalum-session' ? 'Close session' : 'Terminate process';
}

export function SerialPortBlockerDialog({
  open,
  port,
  title = 'Serial port blockers',
  subtitle,
  retryLabel = 'Retry',
  onClose,
  onRetry,
}: SerialPortBlockerDialogProps) {
  const [blockers, setBlockers] = useState<SerialPortBlocker[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyBlockerId, setBusyBlockerId] = useState<string | null>(null);

  const loadBlockers = useCallback(async () => {
    const targetPort = port.trim();
    if (!targetPort) {
      setBlockers([]);
      setMessage(null);
      setError('Select a serial port first.');
      return;
    }

    setLoading(true);
    setError(null);
    const result = await window.tantalum.serialPort.listBlockers({ port: targetPort });
    setLoading(false);

    if (!result.success) {
      setBlockers([]);
      setMessage(null);
      setError(result.error);
      return;
    }

    setBlockers(result.blockers);
    setMessage(result.message || null);
  }, [port]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void loadBlockers();
  }, [loadBlockers, open]);

  const handleTerminate = useCallback(async (blocker: SerialPortBlocker) => {
    if (!blocker.canTerminate) {
      return;
    }

    if (blocker.kind === 'external-process') {
      const confirmed = window.confirm(`Terminate ${blocker.name}${blocker.pid ? ` (${blocker.pid})` : ''}? Unsaved output in that serial tool may be lost.`);
      if (!confirmed) {
        return;
      }
    }

    setBusyBlockerId(blocker.blockerId);
    setError(null);
    const result = await window.tantalum.serialPort.terminateBlocker({ port, blockerId: blocker.blockerId });
    setBusyBlockerId(null);

    if (!result.success) {
      setError(result.error);
      return;
    }

    await loadBlockers();
  }, [loadBlockers, port]);

  return (
    <Modal open={open} title={title} subtitle={subtitle || (port ? `Checking ${port}` : undefined)} onClose={onClose} size="lg">
      <div className="serial-blocker-dialog">
        {error ? (
          <div className="serial-blocker-alert">
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        ) : null}

        {message ? <p className="serial-blocker-message">{message}</p> : null}

        {loading ? (
          <div className="serial-blocker-empty">
            <LoaderCircle size={18} className="spin" />
            <span>Checking serial port blockers...</span>
          </div>
        ) : blockers.length > 0 ? (
          <div className="serial-blocker-list">
            {blockers.map((blocker) => (
              <div key={blocker.blockerId} className="serial-blocker-item">
                <div className="serial-blocker-icon">
                  <CircleStop size={16} />
                </div>
                <div className="serial-blocker-content">
                  <div className="serial-blocker-title-row">
                    <strong>{blocker.name}</strong>
                    <span>{blocker.confidence}</span>
                  </div>
                  <p>{blocker.reason}</p>
                  {blocker.executablePath ? <code title={blocker.executablePath}>{blocker.executablePath}</code> : null}
                  {blocker.commandLine ? <code title={blocker.commandLine}>{blocker.commandLine}</code> : null}
                </div>
                <button
                  className={blocker.kind === 'tantalum-session' ? 'secondary-button compact' : 'danger-button compact'}
                  type="button"
                  disabled={!blocker.canTerminate || busyBlockerId === blocker.blockerId}
                  onClick={() => void handleTerminate(blocker)}
                  title={!blocker.canTerminate ? 'Only confirmed serial-tool processes can be terminated from Tantalum IDE.' : undefined}
                >
                  {busyBlockerId === blocker.blockerId ? <LoaderCircle size={14} className="spin" /> : null}
                  {busyBlockerId === blocker.blockerId ? 'Closing...' : blockerActionLabel(blocker)}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="serial-blocker-empty">
            <SearchX size={18} />
            <span>No Tantalum serial session or confirmed external serial process is holding {port || 'this port'}. Reconnect the board, enter bootloader mode, or try a different USB cable or port.</span>
          </div>
        )}

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={() => void loadBlockers()} disabled={loading || Boolean(busyBlockerId)}>
            <RefreshCcw size={14} className={loading ? 'spin' : undefined} />
            Rescan
          </button>
          <button className="secondary-button" type="button" onClick={onClose}>
            Close
          </button>
          {onRetry ? (
            <button className="primary-button" type="button" onClick={onRetry} disabled={loading || Boolean(busyBlockerId)}>
              {retryLabel}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
