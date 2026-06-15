import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react';
import { CircleStop, Link2, LoaderCircle, RefreshCcw, Send, Trash2 } from 'lucide-react';

import type { UiPreferences } from '@/lib/uiPreferences';
import type { PortInfo, SerialMonitorCloseEvent, SerialMonitorDataEvent, SerialMonitorErrorEvent } from '@/types/electron';

import { SerialPortBlockerDialog } from './SerialPortBlockerDialog';

type SerialLineEnding = 'none' | 'lf' | 'cr' | 'crlf';

export type SerialMonitorSessionState = {
  sessionId: string | null;
  connected: boolean;
  port: string;
  baudRate: number;
};

type SerialMonitorProps = {
  active: boolean;
  selectedPort: string | null;
  selectedBoardName: string | null;
  uiPreferences: UiPreferences;
  onSessionChange?: (state: SerialMonitorSessionState) => void;
};

const COMMON_BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];

const LINE_ENDING_SUFFIX: Record<SerialLineEnding, string> = {
  none: '',
  lf: '\n',
  cr: '\r',
  crlf: '\r\n',
};

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function portLabel(port: PortInfo) {
  const detail = port.manufacturer && port.manufacturer !== 'Unknown' ? ` - ${port.manufacturer}` : '';
  return `${port.path}${detail}`;
}

export function SerialMonitor({ active, selectedPort, selectedBoardName, onSessionChange }: SerialMonitorProps) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState(selectedPort ?? '');
  const [baudRate, setBaudRate] = useState(115200);
  const [lineEnding, setLineEnding] = useState<SerialLineEnding>('lf');
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [blockerDialogOpen, setBlockerDialogOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const outputRef = useRef<HTMLPreElement | null>(null);
  const outputTextRef = useRef('');
  const sessionIdRef = useRef<string | null>(null);
  const selectedPortRef = useRef(selectedPort ?? '');

  const emitSessionChange = useCallback(
    (next: Partial<SerialMonitorSessionState> & Pick<SerialMonitorSessionState, 'sessionId' | 'connected'>) => {
      onSessionChange?.({
        sessionId: next.sessionId,
        connected: next.connected,
        port: next.port ?? port,
        baudRate: next.baudRate ?? baudRate,
      });
    },
    [baudRate, onSessionChange, port],
  );

  const portOptions = useMemo(() => {
    const byPath = new Map<string, PortInfo>();

    for (const item of ports) {
      if (item.path) {
        byPath.set(item.path, item);
      }
    }

    for (const value of [selectedPort, port]) {
      const normalized = value?.trim();
      if (normalized && !byPath.has(normalized)) {
        byPath.set(normalized, { path: normalized, manufacturer: 'Unknown' });
      }
    }

    return Array.from(byPath.values());
  }, [port, ports, selectedPort]);

  const scrollOutputToBottom = useCallback(() => {
    const output = outputRef.current;
    if (!output) {
      return;
    }

    output.scrollTop = output.scrollHeight;
  }, []);

  const appendOutput = useCallback(
    (text: string) => {
      const normalized = stripAnsi(text);
      if (!normalized) {
        return;
      }

      outputTextRef.current += normalized;
      const output = outputRef.current;
      if (output) {
        output.textContent = outputTextRef.current;
        scrollOutputToBottom();
      }
    },
    [scrollOutputToBottom],
  );

  const writeSystemLine = useCallback(
    (message: string) => {
      appendOutput(`[serial] ${message}\n`);
    },
    [appendOutput],
  );

  const clearOutput = useCallback(() => {
    outputTextRef.current = '';
    if (outputRef.current) {
      outputRef.current.textContent = '';
    }
  }, []);

  const copySelectedOutput = useCallback(async () => {
    const selection = window.getSelection()?.toString() ?? '';
    if (!selection) {
      setContextMenu(null);
      return;
    }

    try {
      await navigator.clipboard.writeText(selection);
    } catch {
      setNotice('Unable to copy selected serial output.');
    } finally {
      setContextMenu(null);
    }
  }, []);

  const handleOutputContextMenu = useCallback((event: ReactMouseEvent<HTMLPreElement>) => {
    const selection = window.getSelection()?.toString() ?? '';
    if (!selection) {
      return;
    }

    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const refreshPorts = useCallback(async () => {
    setLoadingPorts(true);
    setNotice(null);

    const result = await window.tantalum.toolchain.listPorts();
    if (result.success) {
      setPorts(result.ports);
      setPort((current) => current || selectedPort || result.ports[0]?.path || '');
    } else {
      setNotice(result.error);
    }

    setLoadingPorts(false);
  }, [selectedPort]);

  const openMonitor = useCallback(async () => {
    const targetPort = port.trim();
    if (!targetPort) {
      setNotice('Select a serial port first.');
      return;
    }

    setConnecting(true);
    setNotice(null);

    const result = await window.tantalum.serialMonitor.open({ port: targetPort, baudRate });
    setConnecting(false);

    if (!result.success) {
      setNotice(result.error);
      writeSystemLine(`Unable to connect: ${result.error}`);
      return;
    }

    sessionIdRef.current = result.sessionId;
    setSessionId(result.sessionId);
    setConnected(true);
    emitSessionChange({
      sessionId: result.sessionId,
      connected: true,
      port: result.port,
      baudRate: result.baudRate,
    });
    writeSystemLine(`Connected to ${result.port} at ${result.baudRate} baud.`);
  }, [baudRate, emitSessionChange, port, writeSystemLine]);

  const closeMonitor = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) {
      return;
    }

    setConnecting(false);
    await window.tantalum.serialMonitor.close(activeSessionId);
  }, []);

  const handleSend = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) {
      return;
    }

    const payload = `${input}${LINE_ENDING_SUFFIX[lineEnding]}`;
    if (!payload) {
      return;
    }

    window.tantalum.serialMonitor.write({ sessionId: activeSessionId, data: payload });
    setInput('');
  }, [input, lineEnding]);

  const handleMonitorData = useEffectEvent((event: SerialMonitorDataEvent) => {
    if (event.sessionId !== sessionIdRef.current) {
      return;
    }

    appendOutput(event.data);
  });

  const handleMonitorError = useEffectEvent((event: SerialMonitorErrorEvent) => {
    if (event.sessionId !== sessionIdRef.current) {
      return;
    }

    setNotice(event.error);
    writeSystemLine(`Error: ${event.error}`);
  });

  const handleMonitorClose = useEffectEvent((event: SerialMonitorCloseEvent) => {
    if (event.sessionId !== sessionIdRef.current) {
      return;
    }

    sessionIdRef.current = null;
    setSessionId(null);
    setConnected(false);
    setConnecting(false);
    emitSessionChange({
      sessionId: null,
      connected: false,
    });

    const message = event.reason === 'disconnected' ? 'Serial port disconnected.' : 'Serial monitor closed.';
    writeSystemLine(message);
  });

  useEffect(() => {
    const offData = window.tantalum.serialMonitor.onData((event) => {
      handleMonitorData(event);
    });
    const offError = window.tantalum.serialMonitor.onError((event) => {
      handleMonitorError(event);
    });
    const offClose = window.tantalum.serialMonitor.onClose((event) => {
      handleMonitorClose(event);
    });

    return () => {
      offData();
      offError();
      offClose();
    };
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleCopyShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') {
        return;
      }

      const target = event.target;
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (isEditableTarget || !window.getSelection()?.toString()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void copySelectedOutput();
    };

    document.addEventListener('keydown', handleCopyShortcut, true);
    return () => {
      document.removeEventListener('keydown', handleCopyShortcut, true);
    };
  }, [active, copySelectedOutput]);

  useEffect(() => {
    if (!active) {
      setContextMenu(null);
      return;
    }

    void refreshPorts();
  }, [active, refreshPorts]);

  useEffect(() => {
    const normalizedSelectedPort = selectedPort?.trim() ?? '';
    if (!normalizedSelectedPort || connected || selectedPortRef.current === normalizedSelectedPort) {
      return;
    }

    selectedPortRef.current = normalizedSelectedPort;
    setPort(normalizedSelectedPort);
  }, [connected, selectedPort]);

  useEffect(() => {
    emitSessionChange({
      sessionId: sessionIdRef.current,
      connected: Boolean(sessionIdRef.current),
    });
  }, [baudRate, emitSessionChange, port]);

  useEffect(() => {
    return () => {
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId) {
        void window.tantalum.serialMonitor.close(activeSessionId);
      }
      emitSessionChange({
        sessionId: null,
        connected: false,
      });
    };
  }, [emitSessionChange]);

  const hasWritableSession = Boolean(sessionId && connected);
  const statusText = connected
    ? `Connected to ${port} at ${baudRate}`
    : selectedBoardName
      ? `Ready for ${selectedBoardName}`
      : 'Not connected';

  return (
    <div className={`serial-monitor console-pane ${active ? 'console-pane-active' : 'console-pane-hidden'}`} onClick={() => setContextMenu(null)}>
      <div className="serial-monitor-toolbar">
        <label className="serial-monitor-field">
          <span>Port</span>
          <select value={port} onChange={(event) => setPort(event.target.value)} disabled={connected || connecting}>
            {portOptions.length > 0 ? (
              portOptions.map((item) => (
                <option key={item.path} value={item.path}>
                  {portLabel(item)}
                </option>
              ))
            ) : (
              <option value="">{loadingPorts ? 'Scanning ports...' : 'No serial ports found'}</option>
            )}
          </select>
        </label>
        <button className="icon-button" type="button" onClick={() => void refreshPorts()} disabled={loadingPorts || connected || connecting} title="Refresh serial ports">
          <RefreshCcw size={15} className={loadingPorts ? 'spin' : undefined} />
        </button>
        <label className="serial-monitor-field serial-monitor-baud-field">
          <span>Baud</span>
          <select value={baudRate} onChange={(event) => setBaudRate(Number(event.target.value))} disabled={connected || connecting}>
            {COMMON_BAUD_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
        </label>
        <button className={connected ? 'boards-hub-btn' : 'boards-hub-btn boards-hub-btn-primary'} type="button" onClick={() => (connected ? void closeMonitor() : void openMonitor())} disabled={connecting || (!connected && !port.trim())}>
          {connecting ? <LoaderCircle size={14} className="spin" /> : connected ? <CircleStop size={14} /> : <Link2 size={14} />}
          {connecting ? 'Connecting...' : connected ? 'Disconnect' : 'Connect'}
        </button>
        <button className="icon-button" type="button" onClick={clearOutput} title="Clear serial output">
          <Trash2 size={15} />
        </button>
        <span className={`serial-monitor-status ${connected ? 'status-pill status-online' : ''}`}>{statusText}</span>
      </div>

      {notice ? (
        <div className="inline-banner inline-banner-warning serial-monitor-notice">
          <span>{notice}</span>
          {port.trim() ? (
            <button className="boards-hub-btn" type="button" onClick={() => setBlockerDialogOpen(true)}>
              Find blockers
            </button>
          ) : null}
        </div>
      ) : null}

      <pre ref={outputRef} className="serial-monitor-output" onContextMenu={handleOutputContextMenu} />

      {contextMenu ? (
        <div className="serial-monitor-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => void copySelectedOutput()}>
            Copy
          </button>
        </div>
      ) : null}

      <form className="serial-monitor-send-row" onSubmit={handleSend}>
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Send to serial port" disabled={!hasWritableSession} />
        <select value={lineEnding} onChange={(event) => setLineEnding(event.target.value as SerialLineEnding)} disabled={!hasWritableSession} title="Line ending">
          <option value="none">No ending</option>
          <option value="lf">Newline</option>
          <option value="cr">Carriage return</option>
          <option value="crlf">Both NL + CR</option>
        </select>
        <button className="boards-hub-btn" type="submit" disabled={!hasWritableSession || (!input && lineEnding === 'none')}>
          <Send size={14} />
          Send
        </button>
      </form>
      <SerialPortBlockerDialog
        open={blockerDialogOpen}
        port={port}
        title="Serial Monitor blockers"
        retryLabel="Retry connect"
        onClose={() => setBlockerDialogOpen(false)}
        onRetry={() => {
          setBlockerDialogOpen(false);
          void openMonitor();
        }}
      />
    </div>
  );
}
