import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

import { SYSTEM_FONT_FAMILY, type UiPreferences } from '@/lib/uiPreferences';
import { fileNameFromPath } from '@/lib/utils';
import type { TerminalDataEvent, TerminalExitEvent } from '@/types/electron';

type TerminalWorkspaceProps = {
  active: boolean;
  currentFolderPath: string | null;
  uiPreferences: UiPreferences;
};

type TerminalTabState = {
  id: string;
  title: string;
  cwd: string;
  pristine: boolean;
  exited: boolean;
};

type WorkspaceNotice = {
  tone: 'info' | 'error';
  message: string;
};

function labelForPath(targetPath: string) {
  const normalized = targetPath.replace(/[\\/]+$/, '');

  if (!normalized || normalized === '/') {
    return 'root';
  }

  if (/^[A-Za-z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }

  return fileNameFromPath(normalized) || targetPath;
}

export function TerminalWorkspace({ active, currentFolderPath, uiPreferences }: TerminalWorkspaceProps) {
  const [tabs, setTabs] = useState<TerminalTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);

  const stageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const terminalRefs = useRef<Map<string, Terminal>>(new Map());
  const fitAddonRefs = useRef<Map<string, FitAddon>>(new Map());
  const bufferedOutputRefs = useRef<Map<string, string>>(new Map());
  const hasInitializedRef = useRef(false);
  const sessionIdsRef = useRef<Set<string>>(new Set());

  const disposeTerminalUi = useCallback((sessionId: string) => {
    terminalRefs.current.get(sessionId)?.dispose();
    terminalRefs.current.delete(sessionId);
    fitAddonRefs.current.delete(sessionId);
    bufferedOutputRefs.current.delete(sessionId);
    stageRefs.current.delete(sessionId);
  }, []);

  const fitTerminal = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    const terminal = terminalRefs.current.get(sessionId);
    const fitAddon = fitAddonRefs.current.get(sessionId);
    if (!terminal || !fitAddon) {
      return;
    }

    fitAddon.fit();
    window.tantalum.terminal.resize({ sessionId, cols: terminal.cols, rows: terminal.rows });

    if (active && activeTabId === sessionId) {
      terminal.focus();
    }
  }, [active, activeTabId]);

  const ensureTerminalInstance = useCallback((sessionId: string) => {
    if (terminalRefs.current.has(sessionId)) {
      return;
    }

    const stage = stageRefs.current.get(sessionId);
    if (!stage) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: SYSTEM_FONT_FAMILY,
      fontSize: uiPreferences.fontSize,
      theme: {
        background: '#00000000',
        foreground: '#e3eaf2',
        cursor: '#6ca6ff',
        selectionBackground: '#182434',
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(stage);
    terminalRefs.current.set(sessionId, terminal);
    fitAddonRefs.current.set(sessionId, fitAddon);

    const bufferedOutput = bufferedOutputRefs.current.get(sessionId);
    if (bufferedOutput) {
      terminal.write(bufferedOutput);
      bufferedOutputRefs.current.delete(sessionId);
    }

    terminal.onData((data) => {
      setTabs((current) =>
        current.map((tab) => (tab.id === sessionId && tab.pristine ? { ...tab, pristine: false } : tab)),
      );
      window.tantalum.terminal.write({ sessionId, data });
    });

    fitTerminal(sessionId);
  }, [fitTerminal, uiPreferences.fontSize]);

  useEffect(() => {
    terminalRefs.current.forEach((terminal, sessionId) => {
      terminal.options.fontFamily = SYSTEM_FONT_FAMILY;
      terminal.options.fontSize = uiPreferences.fontSize;
      fitTerminal(sessionId);
    });
  }, [fitTerminal, uiPreferences.fontSize]);

  const createTerminalTab = useCallback(async (cwd?: string) => {
    setNotice(null);

    const result = await window.tantalum.terminal.create({
      cols: 120,
      rows: 32,
      cwd: cwd ?? undefined,
    });

    if (!result.success) {
      setNotice({ tone: 'error', message: result.error });
      return null;
    }

    sessionIdsRef.current.add(result.sessionId);
    const nextTab: TerminalTabState = {
      id: result.sessionId,
      title: labelForPath(result.cwd),
      cwd: result.cwd,
      pristine: true,
      exited: false,
    };

    setTabs((current) => [...current, nextTab]);
    setActiveTabId(result.sessionId);
    return result.sessionId;
  }, []);

  const openCurrentFolderInTerminal = useCallback(async () => {
    if (!currentFolderPath) {
      setNotice({ tone: 'info', message: 'Open a Project or file first, then send that folder into the terminal.' });
      return;
    }

    setNotice(null);

    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    if (activeTab && !activeTab.exited && activeTab.pristine) {
      const result = await window.tantalum.terminal.navigate({
        sessionId: activeTab.id,
        targetPath: currentFolderPath,
      });

      if (!result.success) {
        setNotice({ tone: 'error', message: result.error });
        return;
      }

      setTabs((current) =>
        current.map((tab) =>
          tab.id === activeTab.id
            ? {
                ...tab,
                cwd: result.cwd,
                title: labelForPath(result.cwd),
              }
            : tab,
        ),
      );
      setActiveTabId(activeTab.id);
      fitTerminal(activeTab.id);
      return;
    }

    await createTerminalTab(currentFolderPath);
  }, [activeTabId, createTerminalTab, currentFolderPath, fitTerminal, tabs]);

  const closeTerminalTab = useCallback(async (sessionId: string) => {
    const nextTabs = tabs.filter((tab) => tab.id !== sessionId);

    sessionIdsRef.current.delete(sessionId);
    disposeTerminalUi(sessionId);
    setTabs(nextTabs);
    setActiveTabId((current) => (current === sessionId ? nextTabs[0]?.id ?? null : current));
    setNotice(null);

    const result = await window.tantalum.terminal.close(sessionId);
    if (!result.success) {
      setNotice({ tone: 'error', message: result.error });
    }
  }, [disposeTerminalUi, tabs]);

  const handleTerminalData = useEffectEvent((event: TerminalDataEvent) => {
    const terminal = terminalRefs.current.get(event.sessionId);
    if (terminal) {
      terminal.write(event.data);
      return;
    }

    bufferedOutputRefs.current.set(
      event.sessionId,
      `${bufferedOutputRefs.current.get(event.sessionId) ?? ''}${event.data}`,
    );
  });

  const handleTerminalExit = useEffectEvent((event: TerminalExitEvent) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === event.sessionId
          ? {
              ...tab,
              pristine: false,
              exited: true,
            }
          : tab,
      ),
    );
  });

  useEffect(() => {
    const offData = window.tantalum.terminal.onData((event) => {
      handleTerminalData(event);
    });
    const offExit = window.tantalum.terminal.onExit((event) => {
      handleTerminalExit(event);
    });
    const trackedSessionIds = sessionIdsRef.current;

    return () => {
      offData();
      offExit();

      const sessionIds = [...trackedSessionIds];
      for (const sessionId of sessionIds) {
        disposeTerminalUi(sessionId);
        void window.tantalum.terminal.close(sessionId);
      }
    };
  }, [disposeTerminalUi]);

  useEffect(() => {
    if (!active || hasInitializedRef.current) {
      return;
    }

    hasInitializedRef.current = true;
    const handle = window.setTimeout(() => {
      void createTerminalTab(currentFolderPath ?? undefined);
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [active, createTerminalTab, currentFolderPath]);

  useEffect(() => {
    if (!active || !activeTabId) {
      return;
    }

    const handle = window.setTimeout(() => {
      ensureTerminalInstance(activeTabId);
      fitTerminal(activeTabId);
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [active, activeTabId, ensureTerminalInstance, fitTerminal, tabs.length]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleResize = () => {
      fitTerminal(activeTabId);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [active, activeTabId, fitTerminal]);

  return (
    <section className={`terminal-workspace ${active ? 'terminal-workspace-active' : ''}`}>
      <div className="terminal-workspace-header">
        <div>
          <p className="eyebrow">Integrated terminal</p>
          <h2>Sessions</h2>
        </div>
        <div className="terminal-workspace-actions">
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void openCurrentFolderInTerminal()}
            disabled={!currentFolderPath}
            title={currentFolderPath ?? 'Open a Project first'}
          >
            <FolderOpen size={16} />
            Open current folder
          </button>
          <button className="primary-button compact" type="button" onClick={() => void createTerminalTab()}>
            <Plus size={16} />
            New tab
          </button>
        </div>
      </div>

      {notice ? <div className={`terminal-notice terminal-notice-${notice.tone}`}>{notice.message}</div> : null}

      <div className="terminal-session-tabs" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`terminal-session-tab ${activeTabId === tab.id ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTabId(tab.id)}
            title={tab.cwd}
          >
            <span className="terminal-session-tab-title">{tab.title}</span>
            {tab.exited ? <span className="terminal-session-badge">Exited</span> : null}
            {tab.pristine && !tab.exited ? <span className="terminal-session-badge">Clean</span> : null}
            <span
              className="terminal-session-tab-close"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void closeTerminalTab(tab.id);
              }}
              role="button"
              tabIndex={-1}
              aria-label={`Close ${tab.title}`}
            >
              <X size={14} />
            </span>
          </button>
        ))}
      </div>

      <div className="terminal-workspace-stage">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-session-panel ${activeTabId === tab.id ? 'active' : ''}`}
          >
            <div
              ref={(node) => {
                if (node) {
                  stageRefs.current.set(tab.id, node);
                  ensureTerminalInstance(tab.id);
                  return;
                }

                stageRefs.current.delete(tab.id);
              }}
              className="terminal-session-shell"
            />
            {tab.exited ? (
              <div className="terminal-session-overlay">
                <p>This shell has exited. You can close the tab or open a new session.</p>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
