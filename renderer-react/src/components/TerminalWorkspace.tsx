import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, PanelRight, Plus, TerminalSquare, X } from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

import { resolveThemePreference, type UiPreferences } from '@/lib/uiPreferences';
import type { TerminalDataEvent, TerminalExitEvent, TerminalShellProfile } from '@/types/electron';

type TerminalWorkspaceProps = {
  active: boolean;
  currentFolderPath: string | null;
  uiPreferences: UiPreferences;
  command?: TerminalWorkspaceCommand | null;
  onStateChange?: (state: TerminalWorkspaceState) => void;
};

export type TerminalSessionStatus = 'running' | 'exited' | 'error';
export type TerminalLocation = 'project' | 'home';
export type TerminalSplitZone = 'left' | 'right' | 'top' | 'bottom';
export type TerminalDropZone = TerminalSplitZone | 'center';
export type TerminalSplitDirection = 'horizontal' | 'vertical';

export type TerminalWorkspaceCommandInput =
  | { type: 'create-project'; shellId?: string; split?: TerminalSplitZone }
  | { type: 'create-home'; shellId?: string; split?: TerminalSplitZone }
  | { type: 'select'; sessionId: string }
  | { type: 'close'; sessionId: string }
  | { type: 'rename'; sessionId: string; title: string }
  | { type: 'move-session'; sessionId: string; targetPaneId: string; targetIndex?: number }
  | { type: 'unsplit-session'; sessionId: string; targetIndex?: number }
  | { type: 'split-session'; sessionId: string; targetPaneId: string; targetSessionId?: string; zone: TerminalSplitZone };

export type TerminalWorkspaceCommand = TerminalWorkspaceCommandInput & {
  id: number;
};

export type TerminalWorkspaceSessionSnapshot = {
  id: string;
  title: string;
  cwd: string | null;
  status: TerminalSessionStatus;
  paneId: string | null;
  shellId: string | null;
  shellLabel: string | null;
};

export type TerminalWorkspacePaneSnapshot = {
  id: string;
  sessionIds: string[];
  activeSessionId: string | null;
};

export type TerminalWorkspaceGroupSnapshot = {
  id: string;
  sessionIds: string[];
  activeSessionId: string | null;
  splitDirection: TerminalSplitDirection | null;
};

export type TerminalWorkspaceState = {
  sessions: TerminalWorkspaceSessionSnapshot[];
  panes: TerminalWorkspacePaneSnapshot[];
  groups: TerminalWorkspaceGroupSnapshot[];
  activePaneId: string | null;
  activeGroupId: string | null;
  activeSessionId: string | null;
  shellProfiles: TerminalShellProfile[];
  defaultShellId: string | null;
};

type TerminalSessionState = TerminalWorkspaceSessionSnapshot & {
  pristine: boolean;
};

type TerminalPaneState = {
  id: string;
  sessionIds: string[];
  activeSessionId: string | null;
};

type TerminalLayoutNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; id: string; direction: TerminalSplitDirection; children: TerminalLayoutNode[] };

type WorkspaceNotice = {
  tone: 'info' | 'error';
  message: string;
};

type ShellMenuState = {
  location: TerminalLocation;
  menuId: string;
  anchorRect: MenuAnchorRect;
};

type MenuAnchorRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type ShellMenuOverlayStyle = CSSProperties & {
  '--terminal-shell-menu-top': string;
  '--terminal-shell-menu-left': string;
  '--terminal-shell-menu-max-height': string;
  '--terminal-shell-menu-flyout-top': string;
  '--terminal-shell-menu-flyout-left': string;
  '--terminal-shell-menu-flyout-max-height': string;
};

type DerivedTerminalGroup = TerminalWorkspaceGroupSnapshot & {
  paneIds: string[];
};

type ShellActionButtonProps = {
  location: TerminalLocation;
  menuId: string;
  label: string;
  disabled?: boolean;
  title?: string;
};

const DEFAULT_PANE_ID = 'terminal-pane-1';
const SHELL_MENU_WIDTH = 220;
const SHELL_MENU_FLYOUT_WIDTH = 230;
const SHELL_MENU_GAP = 6;
const SHELL_MENU_VIEWPORT_MARGIN = 8;
const SHELL_MENU_ROW_HEIGHT = 28;

function terminalTitle(index: number) {
  return `Terminal ${index}`;
}

function clampMenuPosition(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function readMenuAnchorRect(element: HTMLElement): MenuAnchorRect {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

function estimateShellMenuHeight(profileCount: number) {
  const rows = Math.max(1, profileCount) + 1;
  return rows * SHELL_MENU_ROW_HEIGHT + 18;
}

function estimateShellMenuFlyoutHeight(profileCount: number) {
  const profileRows = Math.max(1, profileCount) * 2;
  return profileRows * SHELL_MENU_ROW_HEIGHT + 58;
}

function getShellMenuOverlayStyle(anchorRect: MenuAnchorRect, profileCount: number): ShellMenuOverlayStyle {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const menuHeight = Math.min(estimateShellMenuHeight(profileCount), viewportHeight - SHELL_MENU_VIEWPORT_MARGIN * 2);
  const flyoutHeight = Math.min(estimateShellMenuFlyoutHeight(profileCount), viewportHeight - SHELL_MENU_VIEWPORT_MARGIN * 2);
  const preferredTop = anchorRect.bottom + SHELL_MENU_GAP;
  const top = preferredTop + menuHeight <= viewportHeight - SHELL_MENU_VIEWPORT_MARGIN
    ? preferredTop
    : clampMenuPosition(anchorRect.top - SHELL_MENU_GAP - menuHeight, SHELL_MENU_VIEWPORT_MARGIN, viewportHeight - SHELL_MENU_VIEWPORT_MARGIN - menuHeight);
  const left = clampMenuPosition(
    anchorRect.right - SHELL_MENU_WIDTH,
    SHELL_MENU_VIEWPORT_MARGIN,
    viewportWidth - SHELL_MENU_VIEWPORT_MARGIN - SHELL_MENU_WIDTH,
  );
  const flyoutOpensRight = left + SHELL_MENU_WIDTH + SHELL_MENU_GAP + SHELL_MENU_FLYOUT_WIDTH <= viewportWidth - SHELL_MENU_VIEWPORT_MARGIN;
  const flyoutLeft = clampMenuPosition(
    flyoutOpensRight
      ? left + SHELL_MENU_WIDTH + SHELL_MENU_GAP
      : left - SHELL_MENU_GAP - SHELL_MENU_FLYOUT_WIDTH,
    SHELL_MENU_VIEWPORT_MARGIN,
    viewportWidth - SHELL_MENU_VIEWPORT_MARGIN - SHELL_MENU_FLYOUT_WIDTH,
  );
  const submenuTop = top + Math.max(1, profileCount) * SHELL_MENU_ROW_HEIGHT + 14;
  const flyoutTop = clampMenuPosition(
    submenuTop - SHELL_MENU_GAP,
    SHELL_MENU_VIEWPORT_MARGIN,
    viewportHeight - SHELL_MENU_VIEWPORT_MARGIN - flyoutHeight,
  );

  return {
    '--terminal-shell-menu-top': `${top}px`,
    '--terminal-shell-menu-left': `${left}px`,
    '--terminal-shell-menu-max-height': `${Math.max(120, viewportHeight - SHELL_MENU_VIEWPORT_MARGIN - top)}px`,
    '--terminal-shell-menu-flyout-top': `${flyoutTop}px`,
    '--terminal-shell-menu-flyout-left': `${flyoutLeft}px`,
    '--terminal-shell-menu-flyout-max-height': `${Math.max(140, viewportHeight - SHELL_MENU_VIEWPORT_MARGIN - flyoutTop)}px`,
  };
}

function readTerminalTheme() {
  const root = getComputedStyle(document.documentElement);
  return {
    background: '#00000000',
    foreground: root.getPropertyValue('--text').trim() || '#e3eaf2',
    cursor: root.getPropertyValue('--accent').trim() || '#6ca6ff',
    selectionBackground: root.getPropertyValue('--accent-soft').trim() || '#182434',
  };
}

function createPaneNode(paneId: string): TerminalLayoutNode {
  return { type: 'pane', paneId };
}

function flattenLayoutPaneIds(node: TerminalLayoutNode | null): string[] {
  if (!node) {
    return [];
  }

  if (node.type === 'pane') {
    return [node.paneId];
  }

  return node.children.flatMap((child) => flattenLayoutPaneIds(child));
}

function normalizeLayoutNode(node: TerminalLayoutNode | null): TerminalLayoutNode | null {
  if (!node || node.type === 'pane') {
    return node;
  }

  const children = node.children
    .map((child) => normalizeLayoutNode(child))
    .filter((child): child is TerminalLayoutNode => Boolean(child));

  if (children.length === 0) {
    return null;
  }

  if (children.length === 1) {
    return children[0];
  }

  return { ...node, children };
}

function splitDirectionForZone(zone: TerminalSplitZone): 'horizontal' | 'vertical' {
  return zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
}

function createSplitNode(id: string, direction: TerminalSplitDirection, children: TerminalLayoutNode[]): TerminalLayoutNode {
  return { type: 'split', id, direction, children };
}

function insertPaneSplit(node: TerminalLayoutNode | null, targetPaneId: string, newPaneId: string, zone: TerminalSplitZone): TerminalLayoutNode {
  if (!node) {
    return createPaneNode(newPaneId);
  }

  if (node.type === 'pane') {
    if (node.paneId !== targetPaneId) {
      return node;
    }

    const newPane = createPaneNode(newPaneId);
    const currentPane = createPaneNode(targetPaneId);
    const before = zone === 'left' || zone === 'top';
    return {
      type: 'split',
      id: `terminal-split-${targetPaneId}-${newPaneId}`,
      direction: splitDirectionForZone(zone),
      children: before ? [newPane, currentPane] : [currentPane, newPane],
    };
  }

  return {
    ...node,
    children: node.children.map((child) => insertPaneSplit(child, targetPaneId, newPaneId, zone)),
  };
}

function appendPaneToLayout(node: TerminalLayoutNode | null, paneId: string): TerminalLayoutNode {
  if (!node) {
    return createPaneNode(paneId);
  }

  return createSplitNode(
    `terminal-split-${flattenLayoutPaneIds(node).join('-') || 'root'}-${paneId}`,
    'horizontal',
    [node, createPaneNode(paneId)],
  );
}

function removePaneFromLayout(node: TerminalLayoutNode | null, paneId: string): TerminalLayoutNode | null {
  if (!node) {
    return null;
  }

  if (node.type === 'pane') {
    return node.paneId === paneId ? null : node;
  }

  return normalizeLayoutNode({
    ...node,
    children: node.children
      .map((child) => removePaneFromLayout(child, paneId))
      .filter((child): child is TerminalLayoutNode => Boolean(child)),
  });
}

function replacePaneInLayout(node: TerminalLayoutNode | null, paneId: string, replacement: TerminalLayoutNode): TerminalLayoutNode | null {
  if (!node) {
    return replacement;
  }

  if (node.type === 'pane') {
    return node.paneId === paneId ? replacement : node;
  }

  return normalizeLayoutNode({
    ...node,
    children: node.children.map((child) => replacePaneInLayout(child, paneId, replacement) ?? child),
  });
}

function getSessionPaneId(panes: TerminalPaneState[], sessionId: string) {
  return panes.find((pane) => pane.sessionIds.includes(sessionId))?.id ?? null;
}

function getVisibleLayoutNode(
  layout: TerminalLayoutNode | null,
  panes: TerminalPaneState[],
  activePaneId: string | null,
  activeSessionId: string | null,
) {
  if (!layout) {
    return null;
  }

  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const resolvedPaneId =
    (activePaneId && paneById.has(activePaneId) ? activePaneId : null) ??
    (activeSessionId ? getSessionPaneId(panes, activeSessionId) : null) ??
    flattenLayoutPaneIds(layout).find((paneId) => paneById.has(paneId)) ??
    panes[0]?.id ??
    null;

  if (!resolvedPaneId) {
    return layout;
  }

  const visit = (node: TerminalLayoutNode): TerminalLayoutNode | null => {
    if (node.type === 'pane') {
      return node.paneId === resolvedPaneId ? node : null;
    }

    const splitPaneIds = getDirectSplitPaneIds(node);
    const splitPanes = splitPaneIds
      ?.map((paneId) => paneById.get(paneId) ?? null)
      .filter((pane): pane is TerminalPaneState => Boolean(pane));

    if (
      splitPaneIds?.includes(resolvedPaneId) &&
      splitPanes?.length === 2 &&
      splitPanes.every((pane) => pane.sessionIds.length === 1)
    ) {
      return node;
    }

    for (const child of node.children) {
      const match = visit(child);
      if (match) {
        return match;
      }
    }

    return null;
  };

  return visit(layout) ?? layout;
}

function getFallbackActiveSessionId(sessionIds: string[], removedIndex: number, previousActiveSessionId: string | null, removedSessionIds: Set<string>) {
  if (previousActiveSessionId && !removedSessionIds.has(previousActiveSessionId) && sessionIds.includes(previousActiveSessionId)) {
    return previousActiveSessionId;
  }

  return sessionIds[Math.min(removedIndex, Math.max(0, sessionIds.length - 1))] ?? null;
}

function getDirectSplitPaneIds(node: TerminalLayoutNode): string[] | null {
  if (node.type !== 'split' || node.children.length !== 2 || node.children.some((child) => child.type !== 'pane')) {
    return null;
  }

  return node.children.map((child) => (child as { type: 'pane'; paneId: string }).paneId);
}

function deriveTerminalGroups(panes: TerminalPaneState[], layout: TerminalLayoutNode | null): DerivedTerminalGroup[] {
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const consumedPaneIds = new Set<string>();
  const groups: DerivedTerminalGroup[] = [];

  const visit = (node: TerminalLayoutNode | null) => {
    if (!node) {
      return;
    }

    if (node.type === 'split') {
      const splitPaneIds = getDirectSplitPaneIds(node);
      const splitPanes = splitPaneIds
        ?.map((paneId) => paneById.get(paneId) ?? null)
        .filter((pane): pane is TerminalPaneState => Boolean(pane));

      if (
        splitPaneIds &&
        splitPanes &&
        splitPanes.length === 2 &&
        splitPanes.every((pane) => pane.sessionIds.length === 1)
      ) {
        const sessionIds = splitPanes.flatMap((pane) => pane.sessionIds);
        const activeSessionId = sessionIds.find((sessionId) => splitPanes.some((pane) => pane.activeSessionId === sessionId)) ?? sessionIds[0] ?? null;
        groups.push({
          id: node.id,
          paneIds: splitPaneIds,
          sessionIds,
          activeSessionId,
          splitDirection: node.direction,
        });
        for (const paneId of splitPaneIds) {
          consumedPaneIds.add(paneId);
        }
        return;
      }

      for (const child of node.children) {
        visit(child);
      }
      return;
    }

    const pane = paneById.get(node.paneId);
    if (!pane || consumedPaneIds.has(pane.id)) {
      return;
    }

    for (const sessionId of pane.sessionIds) {
      groups.push({
        id: `${pane.id}:${sessionId}`,
        paneIds: [pane.id],
        sessionIds: [sessionId],
        activeSessionId: sessionId,
        splitDirection: null,
      });
    }
  };

  visit(layout);

  const groupedSessionIds = new Set(groups.flatMap((group) => group.sessionIds));
  for (const pane of panes) {
    if (consumedPaneIds.has(pane.id)) {
      continue;
    }

    for (const sessionId of pane.sessionIds) {
      if (groupedSessionIds.has(sessionId)) {
        continue;
      }

      groups.push({
        id: `${pane.id}:${sessionId}`,
        paneIds: [pane.id],
        sessionIds: [sessionId],
        activeSessionId: sessionId,
        splitDirection: null,
      });
    }
  }

  return groups;
}

function findTerminalSplitGroupForPane(layout: TerminalLayoutNode | null, panes: TerminalPaneState[], paneId: string) {
  return deriveTerminalGroups(panes, layout).find((group) => group.splitDirection && group.paneIds.includes(paneId)) ?? null;
}

function orderedPanes(panes: TerminalPaneState[], layout: TerminalLayoutNode | null) {
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  const ordered = flattenLayoutPaneIds(layout)
    .map((paneId) => byId.get(paneId) ?? null)
    .filter((pane): pane is TerminalPaneState => Boolean(pane));
  const orderedIds = new Set(ordered.map((pane) => pane.id));
  return [...ordered, ...panes.filter((pane) => !orderedIds.has(pane.id))];
}

export function TerminalWorkspace({ active, currentFolderPath, uiPreferences, command, onStateChange }: TerminalWorkspaceProps) {
  const [sessions, setSessions] = useState<TerminalSessionState[]>([]);
  const [panes, setPanes] = useState<TerminalPaneState[]>([]);
  const [layout, setLayout] = useState<TerminalLayoutNode | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const [shellProfiles, setShellProfiles] = useState<TerminalShellProfile[]>([]);
  const [defaultShellId, setDefaultShellId] = useState<string | null>(null);
  const [shellMenu, setShellMenu] = useState<ShellMenuState | null>(null);

  const workspaceStageRef = useRef<HTMLDivElement | null>(null);
  const shellMenuAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const stageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const terminalRefs = useRef<Map<string, Terminal>>(new Map());
  const fitAddonRefs = useRef<Map<string, FitAddon>>(new Map());
  const bufferedOutputRefs = useRef<Map<string, string>>(new Map());
  const sessionsRef = useRef<TerminalSessionState[]>([]);
  const panesRef = useRef<TerminalPaneState[]>([]);
  const layoutRef = useRef<TerminalLayoutNode | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activePaneIdRef = useRef<string | null>(null);
  const shellProfilesRef = useRef<TerminalShellProfile[]>([]);
  const defaultShellIdRef = useRef<string | null>(null);
  const autoCreatedRef = useRef(false);
  const mountedRef = useRef(false);
  const cleanupTimerRef = useRef<number | null>(null);
  const titleCounterRef = useRef(1);
  const paneCounterRef = useRef(1);
  const lastCommandIdRef = useRef<number | null>(null);
  const resolvedTheme = resolveThemePreference(uiPreferences.theme);

  const sessionMap = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const visibleLayout = useMemo(
    () => getVisibleLayoutNode(layout, panes, activePaneId, activeSessionId),
    [activePaneId, activeSessionId, layout, panes],
  );
  const visibleSessionIds = useMemo(
    () => {
      const visiblePaneIds = new Set(flattenLayoutPaneIds(visibleLayout));
      return panes
        .filter((pane) => visiblePaneIds.has(pane.id))
        .map((pane) => pane.activeSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId));
    },
    [panes, visibleLayout],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId]);

  useEffect(() => {
    shellProfilesRef.current = shellProfiles;
  }, [shellProfiles]);

  useEffect(() => {
    defaultShellIdRef.current = defaultShellId;
  }, [defaultShellId]);

  const createPaneId = useCallback(() => {
    paneCounterRef.current += 1;
    return `terminal-pane-${paneCounterRef.current}`;
  }, []);

  const writePaneState = useCallback((nextPanes: TerminalPaneState[], nextLayout: TerminalLayoutNode | null, nextActivePaneId: string | null, nextActiveSessionId: string | null) => {
    panesRef.current = nextPanes;
    layoutRef.current = nextLayout;
    activePaneIdRef.current = nextActivePaneId;
    activeSessionIdRef.current = nextActiveSessionId;
    setPanes(nextPanes);
    setLayout(nextLayout);
    setActivePaneId(nextActivePaneId);
    setActiveSessionId(nextActiveSessionId);
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

    if (active && activeSessionIdRef.current === sessionId) {
      terminal.focus();
    }
  }, [active]);

  const fitVisibleTerminals = useCallback(() => {
    const visiblePaneIds = new Set(flattenLayoutPaneIds(
      getVisibleLayoutNode(layoutRef.current, panesRef.current, activePaneIdRef.current, activeSessionIdRef.current),
    ));

    for (const pane of panesRef.current) {
      if (!visiblePaneIds.has(pane.id)) {
        continue;
      }

      fitTerminal(pane.activeSessionId);
    }
  }, [fitTerminal]);

  const ensureTerminalInstance = useCallback((sessionId: string) => {
    const stage = stageRefs.current.get(sessionId);
    if (!stage) {
      return;
    }

    const existingTerminal = terminalRefs.current.get(sessionId);
    if (existingTerminal) {
      const element = existingTerminal.element;
      if (element && element.parentElement !== stage) {
        stage.appendChild(element);
      }
      fitTerminal(sessionId);
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: uiPreferences.editorFontFamily,
      fontSize: uiPreferences.editorFontSize,
      theme: readTerminalTheme(),
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
      const session = sessionsRef.current.find((entry) => entry.id === sessionId);
      if (!session || session.status !== 'running') {
        return;
      }

      if (session.pristine) {
        setSessions((current) => current.map((entry) => (entry.id === sessionId ? { ...entry, pristine: false } : entry)));
      }

      window.tantalum.terminal.write({ sessionId, data });
    });

    fitTerminal(sessionId);
  }, [fitTerminal, uiPreferences.editorFontFamily, uiPreferences.editorFontSize]);

  const disposeTerminalUi = useCallback((sessionId: string) => {
    terminalRefs.current.get(sessionId)?.dispose();
    terminalRefs.current.delete(sessionId);
    fitAddonRefs.current.delete(sessionId);
    bufferedOutputRefs.current.delete(sessionId);
    stageRefs.current.delete(sessionId);
  }, []);

  const activateSession = useCallback((sessionId: string) => {
    const paneId = getSessionPaneId(panesRef.current, sessionId);
    if (!paneId) {
      return;
    }

    const nextPanes = panesRef.current.map((pane) =>
      pane.id === paneId ? { ...pane, activeSessionId: sessionId } : pane,
    );
    writePaneState(nextPanes, layoutRef.current, paneId, sessionId);

    window.setTimeout(() => {
      ensureTerminalInstance(sessionId);
      fitTerminal(sessionId);
    }, 0);
  }, [ensureTerminalInstance, fitTerminal, writePaneState]);

  const activatePane = useCallback((paneId: string) => {
    const pane = panesRef.current.find((entry) => entry.id === paneId);
    if (!pane) {
      return;
    }

    writePaneState(panesRef.current, layoutRef.current, paneId, pane.activeSessionId);
    if (pane.activeSessionId) {
      window.setTimeout(() => fitTerminal(pane.activeSessionId), 0);
    }
  }, [fitTerminal, writePaneState]);

  const addSessionToLayout = useCallback((sessionId: string, split?: TerminalSplitZone) => {
    const currentPanes = panesRef.current;
    const currentLayout = layoutRef.current;
    const targetPaneId = activePaneIdRef.current ?? currentPanes[0]?.id ?? null;

    if (!targetPaneId || currentPanes.length === 0 || !currentLayout) {
      const paneId = DEFAULT_PANE_ID;
      const nextPanes = [{ id: paneId, sessionIds: [sessionId], activeSessionId: sessionId }];
      writePaneState(nextPanes, createPaneNode(paneId), paneId, sessionId);
      return;
    }

    if (split) {
      if (findTerminalSplitGroupForPane(currentLayout, currentPanes, targetPaneId)) {
        const nonSplitPane = currentPanes.find((pane) => !findTerminalSplitGroupForPane(currentLayout, currentPanes, pane.id)) ?? null;
        if (nonSplitPane) {
          const nextPanes = currentPanes.map((pane) =>
            pane.id === nonSplitPane.id
              ? { ...pane, sessionIds: [...pane.sessionIds, sessionId], activeSessionId: sessionId }
              : pane,
          );
          writePaneState(nextPanes, currentLayout, nonSplitPane.id, sessionId);
          return;
        }

        const standalonePaneId = createPaneId();
        const nextLayout = normalizeLayoutNode(appendPaneToLayout(currentLayout, standalonePaneId));
        writePaneState(
          [...currentPanes, { id: standalonePaneId, sessionIds: [sessionId], activeSessionId: sessionId }],
          nextLayout,
          standalonePaneId,
          sessionId,
        );
        return;
      }

      const targetPane = currentPanes.find((pane) => pane.id === targetPaneId) ?? null;
      const targetSessionId = targetPane?.activeSessionId ?? targetPane?.sessionIds[0] ?? null;
      if (targetPane && targetSessionId && targetPane.sessionIds.length > 1) {
        const splitTargetPaneId = createPaneId();
        const splitSourcePaneId = createPaneId();
        const direction = splitDirectionForZone(split);
        const splitBeforeTarget = split === 'left' || split === 'top';
        const targetSessionIndex = targetPane.sessionIds.indexOf(targetSessionId);
        const remainingTargetSessionIds = targetPane.sessionIds.filter((id) => id !== targetSessionId);
        const remainingTargetPane = remainingTargetSessionIds.length > 0
          ? {
              ...targetPane,
              sessionIds: remainingTargetSessionIds,
              activeSessionId: getFallbackActiveSessionId(remainingTargetSessionIds, targetSessionIndex, targetPane.activeSessionId, new Set([targetSessionId])),
            }
          : null;
        const splitNode = createSplitNode(
          `terminal-split-${splitTargetPaneId}-${splitSourcePaneId}`,
          direction,
          splitBeforeTarget
            ? [createPaneNode(splitSourcePaneId), createPaneNode(splitTargetPaneId)]
            : [createPaneNode(splitTargetPaneId), createPaneNode(splitSourcePaneId)],
        );
        const replacementNode = remainingTargetPane
          ? createSplitNode(
              `terminal-split-${targetPane.id}-${splitTargetPaneId}-${splitSourcePaneId}`,
              direction,
              splitBeforeTarget ? [splitNode, createPaneNode(targetPane.id)] : [createPaneNode(targetPane.id), splitNode],
            )
          : splitNode;
        const nextPanes = [
          ...currentPanes.filter((pane) => pane.id !== targetPane.id),
          ...(remainingTargetPane ? [remainingTargetPane] : []),
          { id: splitTargetPaneId, sessionIds: [targetSessionId], activeSessionId: targetSessionId },
          { id: splitSourcePaneId, sessionIds: [sessionId], activeSessionId: sessionId },
        ];
        const nextLayout = normalizeLayoutNode(replacePaneInLayout(currentLayout, targetPane.id, replacementNode));
        writePaneState(nextPanes, nextLayout, splitSourcePaneId, sessionId);
        return;
      }

      const newPaneId = createPaneId();
      const nextPanes = [
        ...currentPanes,
        { id: newPaneId, sessionIds: [sessionId], activeSessionId: sessionId },
      ];
      const nextLayout = normalizeLayoutNode(insertPaneSplit(currentLayout, targetPaneId, newPaneId, split));
      writePaneState(nextPanes, nextLayout, newPaneId, sessionId);
      return;
    }

    const targetPaneIsSplit = findTerminalSplitGroupForPane(currentLayout, currentPanes, targetPaneId);
    const normalTargetPane = targetPaneIsSplit
      ? currentPanes.find((pane) => !findTerminalSplitGroupForPane(currentLayout, currentPanes, pane.id)) ?? null
      : currentPanes.find((pane) => pane.id === targetPaneId) ?? null;

    if (!normalTargetPane) {
      const standalonePaneId = createPaneId();
      const nextLayout = normalizeLayoutNode(appendPaneToLayout(currentLayout, standalonePaneId));
      writePaneState(
        [...currentPanes, { id: standalonePaneId, sessionIds: [sessionId], activeSessionId: sessionId }],
        nextLayout,
        standalonePaneId,
        sessionId,
      );
      return;
    }

    const nextPanes = currentPanes.map((pane) =>
      pane.id === normalTargetPane.id
        ? { ...pane, sessionIds: [...pane.sessionIds, sessionId], activeSessionId: sessionId }
        : pane,
    );
    writePaneState(nextPanes, currentLayout, normalTargetPane.id, sessionId);
  }, [createPaneId, writePaneState]);

  const removeSessionFromLayout = useCallback((sessionId: string) => {
    const currentPanes = panesRef.current;
    const sourcePane = currentPanes.find((pane) => pane.sessionIds.includes(sessionId)) ?? null;
    if (!sourcePane) {
      return;
    }

    let nextLayout = layoutRef.current;
    let nextPanes = currentPanes
      .map((pane) => {
        if (!pane.sessionIds.includes(sessionId)) {
          return pane;
        }

        const sourceIndex = pane.sessionIds.indexOf(sessionId);
        const sessionIds = pane.sessionIds.filter((id) => id !== sessionId);
        const fallbackIndex = Math.min(sourceIndex, Math.max(0, sessionIds.length - 1));
        return {
          ...pane,
          sessionIds,
          activeSessionId: pane.activeSessionId === sessionId ? sessionIds[fallbackIndex] ?? null : pane.activeSessionId,
        };
      })
      .filter((pane) => pane.sessionIds.length > 0);

    if (!nextPanes.some((pane) => pane.id === sourcePane.id)) {
      nextLayout = removePaneFromLayout(nextLayout, sourcePane.id);
    }

    if (nextPanes.length === 0) {
      writePaneState([], null, null, null);
      return;
    }

    const currentActivePaneExists = activePaneIdRef.current
      ? nextPanes.some((pane) => pane.id === activePaneIdRef.current)
      : false;
    const currentActiveSessionExists = activeSessionIdRef.current
      ? nextPanes.some((pane) => pane.sessionIds.includes(activeSessionIdRef.current ?? ''))
      : false;
    const fallbackPane = currentActivePaneExists
      ? nextPanes.find((pane) => pane.id === activePaneIdRef.current) ?? nextPanes[0]
      : nextPanes[0];
    const nextActivePaneId = currentActivePaneExists ? activePaneIdRef.current : fallbackPane.id;
    const nextActiveSessionId = currentActiveSessionExists ? activeSessionIdRef.current : fallbackPane.activeSessionId;

    writePaneState(nextPanes, nextLayout, nextActivePaneId, nextActiveSessionId);
  }, [writePaneState]);

  const moveSessionToPane = useCallback((sessionId: string, targetPaneId: string, targetIndex?: number) => {
    const currentPanes = panesRef.current;
    const sourcePane = currentPanes.find((pane) => pane.sessionIds.includes(sessionId)) ?? null;
    const targetPane = currentPanes.find((pane) => pane.id === targetPaneId) ?? null;
    if (!sourcePane || !targetPane) {
      return;
    }

    const sourceIndex = sourcePane.sessionIds.indexOf(sessionId);
    const samePane = sourcePane.id === targetPaneId;
    const adjustedIndex = samePane && typeof targetIndex === 'number' && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    let nextLayout = layoutRef.current;
    let removedSourcePane = false;
    const sourceSplitGroup = findTerminalSplitGroupForPane(nextLayout, currentPanes, sourcePane.id);
    const targetSplitGroup = findTerminalSplitGroupForPane(nextLayout, currentPanes, targetPaneId);

    if (targetSplitGroup && sourceSplitGroup?.id !== targetSplitGroup.id && !samePane) {
      return;
    }

    if (sourceSplitGroup && !targetSplitGroup && !samePane) {
      const sourceSplitPaneIds = new Set(sourceSplitGroup.paneIds);
      const sourceSplitSessionIds = sourceSplitGroup.sessionIds.filter((id) => id !== sessionId);
      const insertIndex = Math.max(0, Math.min(targetIndex ?? targetPane.sessionIds.length, targetPane.sessionIds.length));
      const nextPanes = currentPanes
        .filter((pane) => !sourceSplitPaneIds.has(pane.id))
        .map((pane) => {
          if (pane.id !== targetPaneId) {
            return pane;
          }

          const sessionIds = [...pane.sessionIds];
          sessionIds.splice(insertIndex, 0, sessionId, ...sourceSplitSessionIds);
          return { ...pane, sessionIds, activeSessionId: sessionId };
        });
      let nextDissolvedLayout = nextLayout;
      for (const paneId of sourceSplitPaneIds) {
        nextDissolvedLayout = removePaneFromLayout(nextDissolvedLayout, paneId);
      }

      writePaneState(nextPanes, nextDissolvedLayout, targetPaneId, sessionId);
      return;
    }

    let nextPanes = currentPanes
      .map((pane) => {
        if (!pane.sessionIds.includes(sessionId)) {
          return pane;
        }

        const sessionIds = pane.sessionIds.filter((id) => id !== sessionId);
        if (sessionIds.length === 0 && pane.id !== targetPaneId) {
          removedSourcePane = true;
        }

        return {
          ...pane,
          sessionIds,
          activeSessionId: pane.activeSessionId === sessionId ? sessionIds[Math.min(sourceIndex, Math.max(0, sessionIds.length - 1))] ?? null : pane.activeSessionId,
        };
      })
      .filter((pane) => pane.sessionIds.length > 0 || pane.id === targetPaneId);

    nextPanes = nextPanes.map((pane) => {
      if (pane.id !== targetPaneId) {
        return pane;
      }

      const insertIndex = Math.max(0, Math.min(adjustedIndex ?? pane.sessionIds.length, pane.sessionIds.length));
      const sessionIds = [...pane.sessionIds];
      sessionIds.splice(insertIndex, 0, sessionId);
      return { ...pane, sessionIds, activeSessionId: sessionId };
    });

    if (removedSourcePane) {
      nextLayout = removePaneFromLayout(nextLayout, sourcePane.id);
    }

    writePaneState(nextPanes, nextLayout, targetPaneId, sessionId);
  }, [writePaneState]);

  const moveSessionToStandalone = useCallback((sessionId: string, targetIndex?: number) => {
    const currentPanes = panesRef.current;
    const sourcePane = currentPanes.find((pane) => pane.sessionIds.includes(sessionId)) ?? null;
    if (!sourcePane) {
      return;
    }

    const sourceSplitGroup = findTerminalSplitGroupForPane(layoutRef.current, currentPanes, sourcePane.id);
    if (!sourceSplitGroup) {
      return;
    }

    const targetPaneId = sourceSplitGroup.paneIds.find((paneId) => paneId !== sourcePane.id) ?? null;
    const targetPane = targetPaneId ? currentPanes.find((pane) => pane.id === targetPaneId) ?? null : null;
    if (!targetPane) {
      return;
    }

    moveSessionToPane(sessionId, targetPane.id, targetIndex ?? targetPane.sessionIds.length);
  }, [moveSessionToPane]);

  const splitSessionIntoPane = useCallback((sessionId: string, targetPaneId: string, zone: TerminalSplitZone, targetSessionId?: string) => {
    const currentPanes = panesRef.current;
    const sourcePane = currentPanes.find((pane) => pane.sessionIds.includes(sessionId)) ?? null;
    const targetPane = currentPanes.find((pane) => pane.id === targetPaneId) ?? null;
    if (!sourcePane || !targetPane) {
      return;
    }

    const fallbackTargetSessionId = targetPane.activeSessionId && targetPane.activeSessionId !== sessionId
      ? targetPane.activeSessionId
      : targetPane.sessionIds.find((id) => id !== sessionId) ?? null;
    const resolvedTargetSessionId = targetSessionId && targetPane.sessionIds.includes(targetSessionId)
      ? targetSessionId
      : fallbackTargetSessionId;
    if (!resolvedTargetSessionId || resolvedTargetSessionId === sessionId) {
      return;
    }

    const sourceSplitGroup = findTerminalSplitGroupForPane(layoutRef.current, currentPanes, sourcePane.id);
    const targetSplitGroup = findTerminalSplitGroupForPane(layoutRef.current, currentPanes, targetPane.id);
    if (targetSplitGroup && sourceSplitGroup?.id !== targetSplitGroup.id) {
      return;
    }

    const sourcePaneId = sourcePane.id;
    const targetPaneOriginalId = targetPane.id;
    const splitTargetPaneId = createPaneId();
    const splitSourcePaneId = createPaneId();
    const direction = splitDirectionForZone(zone);
    const splitBeforeTarget = zone === 'left' || zone === 'top';
    const removedSessionIds = new Set([sessionId, resolvedTargetSessionId]);
    let nextLayout = layoutRef.current;
    const panesAfterExtraction: TerminalPaneState[] = [];
    let sourcePaneRemoved = false;
    let targetPaneHasRemainingSessions = false;

    for (const pane of currentPanes) {
      const removesDraggedSession = pane.sessionIds.includes(sessionId);
      const removesTargetSession = pane.sessionIds.includes(resolvedTargetSessionId);
      if (!removesDraggedSession && !removesTargetSession) {
        panesAfterExtraction.push(pane);
        continue;
      }

      const firstRemovedIndex = Math.min(
        ...[sessionId, resolvedTargetSessionId]
          .map((removedId) => pane.sessionIds.indexOf(removedId))
          .filter((index) => index >= 0),
      );
      const sessionIds = pane.sessionIds.filter((id) => !removedSessionIds.has(id));
      if (sessionIds.length === 0) {
        if (pane.id === sourcePaneId) {
          sourcePaneRemoved = true;
        }
        continue;
      }

      if (pane.id === targetPaneOriginalId) {
        targetPaneHasRemainingSessions = true;
      }

      panesAfterExtraction.push({
        ...pane,
        sessionIds,
        activeSessionId: getFallbackActiveSessionId(sessionIds, firstRemovedIndex, pane.activeSessionId, removedSessionIds),
      });
    }

    if (sourcePaneRemoved && sourcePaneId !== targetPaneOriginalId) {
      nextLayout = removePaneFromLayout(nextLayout, sourcePaneId);
    }

    const splitNode = createSplitNode(
      `terminal-split-${splitTargetPaneId}-${splitSourcePaneId}`,
      direction,
      splitBeforeTarget
        ? [createPaneNode(splitSourcePaneId), createPaneNode(splitTargetPaneId)]
        : [createPaneNode(splitTargetPaneId), createPaneNode(splitSourcePaneId)],
    );
    const replacementNode = targetPaneHasRemainingSessions
      ? createSplitNode(
          `terminal-split-${targetPaneOriginalId}-${splitTargetPaneId}-${splitSourcePaneId}`,
          direction,
          splitBeforeTarget ? [splitNode, createPaneNode(targetPaneOriginalId)] : [createPaneNode(targetPaneOriginalId), splitNode],
        )
      : splitNode;
    nextLayout = normalizeLayoutNode(replacePaneInLayout(nextLayout, targetPaneOriginalId, replacementNode));

    writePaneState(
      [
        ...panesAfterExtraction,
        { id: splitTargetPaneId, sessionIds: [resolvedTargetSessionId], activeSessionId: resolvedTargetSessionId },
        { id: splitSourcePaneId, sessionIds: [sessionId], activeSessionId: sessionId },
      ],
      nextLayout,
      splitSourcePaneId,
      sessionId,
    );
  }, [createPaneId, writePaneState]);

  const renameTerminalSession = useCallback((sessionId: string, title: string) => {
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === sessionId);
      const fallback = terminalTitle(index >= 0 ? index + 1 : titleCounterRef.current);
      const nextTitle = title.trim() || fallback;
      return current.map((session) => (session.id === sessionId ? { ...session, title: nextTitle } : session));
    });
  }, []);

  const resolveShellId = useCallback((shellId?: string | null) => {
    if (shellId && shellProfilesRef.current.some((profile) => profile.id === shellId)) {
      return shellId;
    }

    return defaultShellIdRef.current ?? shellProfilesRef.current[0]?.id ?? undefined;
  }, []);

  const createTerminalSession = useCallback(async (location: TerminalLocation, options: { shellId?: string; split?: TerminalSplitZone } = {}) => {
    if (location === 'project' && !currentFolderPath) {
      setNotice({ tone: 'info', message: 'Open a Project Space first.' });
      return;
    }

    setShellMenu(null);
    setNotice(null);
    const shellId = resolveShellId(options.shellId);
    const shellProfile = shellProfilesRef.current.find((profile) => profile.id === shellId) ?? null;
    const title = terminalTitle(titleCounterRef.current);
    titleCounterRef.current += 1;

    const result = await window.tantalum.terminal.create({
      cols: 120,
      rows: 32,
      cwd: location === 'project' ? currentFolderPath ?? undefined : undefined,
      shellId,
    });

    if (!result.success) {
      setNotice({ tone: 'error', message: result.error });
      return;
    }

    if (!mountedRef.current) {
      void window.tantalum.terminal.close(result.sessionId);
      return;
    }

    const session: TerminalSessionState = {
      id: result.sessionId,
      title,
      cwd: result.cwd,
      status: 'running',
      pristine: true,
      paneId: null,
      shellId: result.shellId ?? shellProfile?.id ?? shellId ?? null,
      shellLabel: result.shellLabel ?? shellProfile?.label ?? null,
    };

    setSessions((current) => [...current, session]);
    addSessionToLayout(result.sessionId, options.split);

    window.setTimeout(() => {
      ensureTerminalInstance(result.sessionId);
      fitTerminal(result.sessionId);
    }, 0);
  }, [addSessionToLayout, currentFolderPath, ensureTerminalInstance, fitTerminal, resolveShellId]);

  const closeTerminalSession = useCallback((sessionId: string) => {
    disposeTerminalUi(sessionId);
    void window.tantalum.terminal.close(sessionId);
    removeSessionFromLayout(sessionId);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
  }, [disposeTerminalUi, removeSessionFromLayout]);

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
    setSessions((current) =>
      current.map((session) =>
        session.id === event.sessionId
          ? {
              ...session,
              pristine: false,
              status: 'exited',
            }
          : session,
      ),
    );
  });

  useEffect(() => {
    let canceled = false;

    void window.tantalum.terminal.listShells().then((result) => {
      if (canceled) {
        return;
      }

      if (!result.success) {
        setNotice({ tone: 'error', message: result.error });
        return;
      }

      setShellProfiles(result.profiles);
      setDefaultShellId(result.defaultShellId);
    });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }

    return () => {
      mountedRef.current = false;
      cleanupTimerRef.current = window.setTimeout(() => {
        for (const session of sessionsRef.current) {
          disposeTerminalUi(session.id);
          void window.tantalum.terminal.close(session.id);
        }
      }, 0);
    };
  }, [disposeTerminalUi]);

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
    if (!active || autoCreatedRef.current || sessions.length > 0) {
      return;
    }

    autoCreatedRef.current = true;
    void createTerminalSession(currentFolderPath ? 'project' : 'home');
  }, [active, createTerminalSession, currentFolderPath, sessions.length]);

  useEffect(() => {
    if (!command || command.id === lastCommandIdRef.current) {
      return;
    }

    lastCommandIdRef.current = command.id;
    switch (command.type) {
      case 'create-project':
        void createTerminalSession('project', { shellId: command.shellId, split: command.split });
        break;
      case 'create-home':
        void createTerminalSession('home', { shellId: command.shellId, split: command.split });
        break;
      case 'select':
        activateSession(command.sessionId);
        break;
      case 'close':
        closeTerminalSession(command.sessionId);
        break;
      case 'rename':
        renameTerminalSession(command.sessionId, command.title);
        break;
      case 'move-session':
        moveSessionToPane(command.sessionId, command.targetPaneId, command.targetIndex);
        break;
      case 'unsplit-session':
        moveSessionToStandalone(command.sessionId, command.targetIndex);
        break;
      case 'split-session':
        splitSessionIntoPane(command.sessionId, command.targetPaneId, command.zone, command.targetSessionId);
        break;
    }
  }, [activateSession, closeTerminalSession, command, createTerminalSession, moveSessionToPane, moveSessionToStandalone, renameTerminalSession, splitSessionIntoPane]);

  useEffect(() => {
    const paneOrder = orderedPanes(panes, layout);
    const sessionPane = new Map<string, string>();
    for (const pane of paneOrder) {
      for (const sessionId of pane.sessionIds) {
        sessionPane.set(sessionId, pane.id);
      }
    }
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const orderedSessions = paneOrder.flatMap((pane) =>
      pane.sessionIds
        .map((sessionId) => sessionById.get(sessionId) ?? null)
        .filter((session): session is TerminalSessionState => Boolean(session)),
    );
    const orderedIds = new Set(orderedSessions.map((session) => session.id));
    const snapshots = [...orderedSessions, ...sessions.filter((session) => !orderedIds.has(session.id))];
    const groups = deriveTerminalGroups(paneOrder, layout);
    const activeGroupId = groups.find((group) => (
      (activeSessionId && group.sessionIds.includes(activeSessionId)) ||
      (activePaneId && group.paneIds.includes(activePaneId))
    ))?.id ?? null;

    onStateChange?.({
      sessions: snapshots.map(({ id, title, cwd, status, shellId, shellLabel }) => ({
        id,
        title,
        cwd,
        status,
        shellId,
        shellLabel,
        paneId: sessionPane.get(id) ?? null,
      })),
      panes: paneOrder.map((pane) => ({
        id: pane.id,
        sessionIds: pane.sessionIds,
        activeSessionId: pane.activeSessionId,
      })),
      groups: groups.map(({ id, sessionIds, activeSessionId, splitDirection }) => ({
        id,
        sessionIds,
        activeSessionId,
        splitDirection,
      })),
      activePaneId,
      activeGroupId,
      activeSessionId,
      shellProfiles,
      defaultShellId,
    });
  }, [activePaneId, activeSessionId, defaultShellId, layout, onStateChange, panes, sessions, shellProfiles]);

  useEffect(() => {
    const theme = readTerminalTheme();
    for (const terminal of terminalRefs.current.values()) {
      terminal.options.fontFamily = uiPreferences.editorFontFamily;
      terminal.options.fontSize = uiPreferences.editorFontSize;
      terminal.options.theme = theme;
    }
    fitVisibleTerminals();
  }, [fitVisibleTerminals, resolvedTheme, uiPreferences.editorFontFamily, uiPreferences.editorFontSize, uiPreferences.theme]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handle = window.setTimeout(() => {
      for (const sessionId of visibleSessionIds) {
        ensureTerminalInstance(sessionId);
      }
      fitVisibleTerminals();
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [active, ensureTerminalInstance, fitVisibleTerminals, layout, panes, sessions.length, visibleSessionIds]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleResize = () => {
      fitVisibleTerminals();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [active, fitVisibleTerminals]);

  useEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') {
      return;
    }

    const stage = workspaceStageRef.current;
    if (!stage) {
      return;
    }

    const observer = new ResizeObserver(() => {
      fitVisibleTerminals();
    });

    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, [active, fitVisibleTerminals]);

  useEffect(() => {
    if (!shellMenu) {
      return;
    }

    const updateMenuPosition = () => {
      setShellMenu((current) => {
        if (!current) {
          return null;
        }

        const anchor = shellMenuAnchorRefs.current.get(current.menuId);
        return anchor ? { ...current, anchorRect: readMenuAnchorRect(anchor) } : null;
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.terminal-shell-split-button, .terminal-shell-menu')) {
        return;
      }
      setShellMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShellMenu(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [shellMenu]);

  const renderShellMenuProfiles = (location: TerminalLocation, split?: TerminalSplitZone) => {
    const profiles = shellProfiles.length > 0 ? shellProfiles : [];

    if (profiles.length === 0) {
      return (
        <button type="button" onClick={() => void createTerminalSession(location, { split })}>
          <TerminalSquare size={13} />
          Default shell
        </button>
      );
    }

    return profiles.map((profile) => (
      <button key={`${split ?? 'tab'}:${profile.id}`} type="button" onClick={() => void createTerminalSession(location, { shellId: profile.id, split })}>
        <TerminalSquare size={13} />
        {profile.label}
      </button>
    ));
  };

  const ShellActionButton = ({ location, menuId, label, disabled, title }: ShellActionButtonProps) => {
    const isMenuOpen = shellMenu?.menuId === menuId;
    const menuStyle = isMenuOpen && shellMenu ? getShellMenuOverlayStyle(shellMenu.anchorRect, shellProfiles.length) : null;

    const toggleMenu = () => {
      const anchor = shellMenuAnchorRefs.current.get(menuId);
      if (!anchor) {
        return;
      }

      setShellMenu((current) => (
        current?.menuId === menuId
          ? null
          : { location, menuId, anchorRect: readMenuAnchorRect(anchor) }
      ));
    };

    return (
      <div
        ref={(node) => {
          if (node) {
            shellMenuAnchorRefs.current.set(menuId, node);
            return;
          }

          shellMenuAnchorRefs.current.delete(menuId);
        }}
        className="terminal-shell-split-button"
      >
        <button
          className="boards-hub-btn boards-hub-btn-primary terminal-shell-main-btn"
          type="button"
          onClick={() => void createTerminalSession(location)}
          disabled={disabled}
          title={title}
        >
          <Plus size={14} />
          {label}
        </button>
        <button
          className="boards-hub-btn boards-hub-btn-primary terminal-shell-menu-btn"
          type="button"
          onClick={toggleMenu}
          disabled={disabled}
          title={`${label} options`}
          aria-label={`${label} options`}
          aria-expanded={isMenuOpen}
        >
          <ChevronDown size={14} />
        </button>
        {isMenuOpen && menuStyle ? createPortal((
          <div
            className="terminal-shell-menu"
            role="menu"
            style={menuStyle}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {renderShellMenuProfiles(location)}
            <div className="terminal-shell-menu-separator" />
            <div className="terminal-shell-menu-submenu">
              <button type="button" className="terminal-shell-menu-submenu-trigger">
                <PanelRight size={13} />
                Split terminal
                <ChevronRight size={13} />
              </button>
              <div className="terminal-shell-menu-flyout">
                <div className="terminal-shell-menu-label" aria-hidden="true">
                  Choose shell for right split
                </div>
                {renderShellMenuProfiles(location, 'right')}
                <div className="terminal-shell-menu-label" aria-hidden="true">
                  Choose shell for bottom split
                </div>
                {renderShellMenuProfiles(location, 'bottom')}
              </div>
            </div>
          </div>
        ), document.body) : null}
      </div>
    );
  };

  const renderTerminalTab = (pane: TerminalPaneState, session: TerminalSessionState) => {
    const selected = pane.activeSessionId === session.id;
    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      activateSession(session.id);
    };

    return (
      <div
        key={session.id}
        className={`terminal-pane-tab ${selected ? 'active' : ''}`.trim()}
        role="tab"
        tabIndex={selected ? 0 : -1}
        aria-selected={selected}
        onClick={() => activateSession(session.id)}
        onKeyDown={handleKeyDown}
        title={session.cwd ? `${session.title} - ${session.cwd}` : session.title}
      >
        <span className="terminal-pane-tab-leading" aria-hidden="true">
          <TerminalSquare size={13} />
        </span>
        <span className="terminal-pane-tab-copy">
          <span className="terminal-pane-tab-title">{session.title}</span>
        </span>
        <button
          className="terminal-pane-tab-close"
          type="button"
          tabIndex={-1}
          draggable={false}
          aria-label={`Close ${session.title}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            closeTerminalSession(session.id);
          }}
          onDragStart={(event) => event.preventDefault()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <X size={12} />
        </button>
      </div>
    );
  };

  const renderPane = (paneId: string) => {
    const pane = panes.find((entry) => entry.id === paneId);
    if (!pane) {
      return null;
    }

    const paneSessions = pane.sessionIds
      .map((sessionId) => sessionMap.get(sessionId) ?? null)
      .filter((session): session is TerminalSessionState => Boolean(session));

    return (
      <section
        key={pane.id}
        className={`terminal-pane ${activePaneId === pane.id ? 'active' : ''}`}
        onClick={() => activatePane(pane.id)}
      >
        <div className="terminal-pane-tabs" role="tablist" aria-label="Terminal sessions">
          {paneSessions.map((session) => renderTerminalTab(pane, session))}
        </div>
        <div className="terminal-pane-body">
          {paneSessions.map((session) => (
            <div key={session.id} className={`terminal-session-panel ${pane.activeSessionId === session.id ? 'active' : ''}`}>
              <div
                ref={(node) => {
                  if (node) {
                    stageRefs.current.set(session.id, node);
                    ensureTerminalInstance(session.id);
                    return;
                  }

                  stageRefs.current.delete(session.id);
                }}
                className="terminal-session-shell"
              />
              {session.status === 'exited' ? (
                <div className="terminal-session-overlay boards-hub-note">
                  <p>This shell has exited. Close it or open a new one.</p>
                  <div className="terminal-session-overlay-actions">
                    <button
                      className="boards-hub-btn boards-inspector-footer-danger"
                      type="button"
                      onClick={() => closeTerminalSession(session.id)}
                    >
                      Close session
                    </button>
                    <button className="boards-hub-btn boards-hub-btn-primary" type="button" onClick={() => void createTerminalSession('home')}>
                      Home shell
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    );
  };

  const renderLayoutNode = (node: TerminalLayoutNode | null): ReactNode => {
    if (!node) {
      return null;
    }

    if (node.type === 'pane') {
      return renderPane(node.paneId);
    }

    return (
      <div key={node.id} className={`terminal-split terminal-split-${node.direction}`}>
        {node.children.map((child) => renderLayoutNode(child))}
      </div>
    );
  };

  return (
    <section className={`terminal-hub ${active ? 'terminal-hub-active' : ''}`}>
      <header className="terminal-hub-hero">
        <div>
          <h1>Terminal</h1>
          <p>Run shells in your project folder or home directory.</p>
        </div>
        <div className="terminal-hub-hero-actions">
          <ShellActionButton
            location="project"
            menuId="terminal-header-project"
            label="Project shell"
            disabled={!currentFolderPath}
            title={currentFolderPath ?? 'Open a Project Space first'}
          />
          <ShellActionButton location="home" menuId="terminal-header-home" label="Home shell" />
        </div>
      </header>

      {notice ? (
        <div className={`terminal-hub-notice boards-hub-note ${notice.tone === 'error' ? 'boards-hub-note-error' : ''}`}>{notice.message}</div>
      ) : null}

      <div ref={workspaceStageRef} className="terminal-hub-stage">
        {sessions.length === 0 ? (
          <div className="terminal-hub-empty">
            <TerminalSquare size={26} strokeWidth={1.5} />
            <strong>No shells open</strong>
            <p>Open a project shell or start one in your home directory.</p>
            <div className="terminal-hub-empty-actions">
              <ShellActionButton
                location="project"
                menuId="terminal-empty-project"
                label="Project shell"
                disabled={!currentFolderPath}
                title={currentFolderPath ?? 'Open a Project Space first'}
              />
              <ShellActionButton location="home" menuId="terminal-empty-home" label="Home shell" />
            </div>
          </div>
        ) : (
          renderLayoutNode(visibleLayout)
        )}
      </div>
    </section>
  );
}
