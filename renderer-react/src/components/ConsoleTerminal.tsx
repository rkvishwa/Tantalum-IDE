import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

import type { UiPreferences } from '@/lib/uiPreferences';
import type { TerminalDataEvent, TerminalExitEvent } from '@/types/electron';

type ConsoleTerminalProps = {
  active: boolean;
  currentFolderPath: string | null;
  uiPreferences: UiPreferences;
};

export function ConsoleTerminal({ active, currentFolderPath, uiPreferences }: ConsoleTerminalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCwd, setSessionCwd] = useState<string | null>(null);
  const [pristine, setPristine] = useState(true);
  const [exited, setExited] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const bufferedOutputRef = useRef('');
  const hasInitializedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const pristineRef = useRef(true);

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const activeSessionId = sessionIdRef.current;

    if (!terminal || !fitAddon || !activeSessionId) {
      return;
    }

    fitAddon.fit();
    window.tantalum.terminal.resize({ sessionId: activeSessionId, cols: terminal.cols, rows: terminal.rows });

    if (active) {
      terminal.focus();
    }
  }, [active]);

  const createSession = useCallback(async () => {
    setNotice(null);

    if (terminalRef.current) {
      terminalRef.current.reset();
      terminalRef.current.clear();
    }

    const result = await window.tantalum.terminal.create({
      cols: 120,
      rows: 16,
      cwd: currentFolderPath ?? undefined,
    });

    if (!result.success) {
      setNotice(result.error);
      return;
    }

    sessionIdRef.current = result.sessionId;
    pristineRef.current = true;
    setSessionId(result.sessionId);
    setSessionCwd(result.cwd);
    setPristine(true);
    setExited(false);

    window.setTimeout(() => {
      fitTerminal();
    }, 0);
  }, [currentFolderPath, fitTerminal]);

  const handleTerminalData = useEffectEvent((event: TerminalDataEvent) => {
    if (event.sessionId !== sessionIdRef.current) {
      return;
    }

    const terminal = terminalRef.current;
    if (terminal) {
      terminal.write(event.data);
      return;
    }

    bufferedOutputRef.current += event.data;
  });

  const handleTerminalExit = useEffectEvent((event: TerminalExitEvent) => {
    if (event.sessionId !== sessionIdRef.current) {
      return;
    }

    sessionIdRef.current = null;
    setSessionId(null);
    setExited(true);
    setPristine(false);
    pristineRef.current = false;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: uiPreferences.fontFamily,
      fontSize: uiPreferences.fontSize,
      theme: {
        background: '#0b1117',
        foreground: '#e3eaf2',
        cursor: '#6ca6ff',
        selectionBackground: '#182434',
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    if (bufferedOutputRef.current) {
      terminal.write(bufferedOutputRef.current);
      bufferedOutputRef.current = '';
    }

    terminal.onData((data) => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) {
        return;
      }

      if (pristineRef.current) {
        pristineRef.current = false;
        setPristine(false);
      }

      window.tantalum.terminal.write({ sessionId: activeSessionId, data });
    });

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [uiPreferences.fontFamily, uiPreferences.fontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.fontFamily = uiPreferences.fontFamily;
    terminal.options.fontSize = uiPreferences.fontSize;
    fitTerminal();
  }, [fitTerminal, uiPreferences.fontFamily, uiPreferences.fontSize]);

  useEffect(() => {
    const offData = window.tantalum.terminal.onData((event) => {
      handleTerminalData(event);
    });
    const offExit = window.tantalum.terminal.onExit((event) => {
      handleTerminalExit(event);
    });

    return () => {
      offData();
      offExit();
    };
  }, []);

  useEffect(() => {
    if (!active || hasInitializedRef.current) {
      return;
    }

    hasInitializedRef.current = true;
    const handle = window.setTimeout(() => {
      void createSession();
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [active, createSession]);

  useEffect(() => {
    if (!active || !sessionId || !pristine || !currentFolderPath || currentFolderPath === sessionCwd) {
      return;
    }

    const handle = window.setTimeout(() => {
      void window.tantalum.terminal
        .navigate({
          sessionId,
          targetPath: currentFolderPath,
        })
        .then((result) => {
          if (result.success) {
            setSessionCwd(result.cwd);
          } else {
            setNotice(result.error);
          }
        });
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [active, currentFolderPath, pristine, sessionCwd, sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handle = window.setTimeout(() => {
      fitTerminal();
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [active, fitTerminal, sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleResize = () => {
      fitTerminal();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [active, fitTerminal]);

  useEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(() => {
      fitTerminal();
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [active, fitTerminal]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    return () => {
      void window.tantalum.terminal.close(sessionId);
    };
  }, [sessionId]);

  return (
    <div className={`terminal-stage console-pane ${active ? 'console-pane-active' : 'console-pane-hidden'}`}>
      <div ref={containerRef} className="console-terminal-shell" />
      {notice ? <div className="console-terminal-overlay">{notice}</div> : null}
      {exited ? (
        <div className="console-terminal-overlay console-terminal-overlay-actions">
          <p>The editor terminal session has ended.</p>
          <button className="secondary-button compact" type="button" onClick={() => void createSession()}>
            <RefreshCcw size={14} />
            Restart terminal
          </button>
        </div>
      ) : null}
    </div>
  );
}
