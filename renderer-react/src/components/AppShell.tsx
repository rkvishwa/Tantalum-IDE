import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Models } from 'appwrite';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Copy,
  Download,
  LoaderCircle,
  Maximize2,
  Minus,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
  UserRound,
  X,
} from 'lucide-react';

import { signOut } from '@/lib/auth';
import type { MenuAction, ToolchainNotification } from '@/types/electron';
import {
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  normalizeUiPreferences,
  resolveThemePreference,
  saveUiPreferences,
  type UiPreferences,
} from '@/lib/uiPreferences';

import { IDEWorkspace, type SidebarView } from './IDEWorkspace';
import { Modal } from './Modal';
import { SettingsPage, type SettingsTab } from './SettingsPage';

type AppShellProps = {
  appName: string;
  version: string;
  platform: string;
  user: Models.User<Models.Preferences>;
  onSignedOut: () => void;
};

type View = 'workspace' | 'settings';
type AppRoute =
  | { view: 'workspace'; sidebar: SidebarView }
  | { view: 'settings'; tab: SettingsTab };
type AppNavigationState = {
  entries: AppRoute[];
  index: number;
};
type WindowControlAction = 'minimize' | 'maximize' | 'close';
type TitlebarMenuId = 'file' | 'edit' | 'view' | 'sketch' | 'help';
type PanelVisibilityState = {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
};
type TitlebarMenuSeparator = {
  id: string;
  type: 'separator';
};
type TitlebarMenuCommand = {
  id: string;
  label: string;
  shortcut?: string;
  title?: string;
  disabled?: boolean;
  action?: MenuAction;
  onSelect?: () => void;
  submenu?: TitlebarMenuItem[];
};
type TitlebarMenuItem = TitlebarMenuSeparator | TitlebarMenuCommand;
type TitlebarMenuGroup = {
  id: TitlebarMenuId;
  label: string;
  items: TitlebarMenuItem[];
};
type ToolchainNotificationRestoreRequest = {
  requestId: number;
  notification: ToolchainNotification;
};

const PANEL_VISIBILITY_STORAGE_KEY = 'tantalum-panel-visibility';
const MAX_APP_HISTORY_ENTRIES = 100;
const DEFAULT_WORKSPACE_SIDEBAR: SidebarView = 'explorer';
const DEFAULT_SETTINGS_TAB: SettingsTab = 'appearance';
const DEFAULT_APP_ROUTE: AppRoute = { view: 'workspace', sidebar: DEFAULT_WORKSPACE_SIDEBAR };
const DEFAULT_PANEL_VISIBILITY: PanelVisibilityState = {
  leftPanelOpen: true,
  rightPanelOpen: false,
  bottomPanelOpen: false,
};

function baseNameFromPath(targetPath: string) {
  const normalized = targetPath.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || targetPath;
}

function isMenuSeparator(item: TitlebarMenuItem): item is TitlebarMenuSeparator {
  return 'type' in item && item.type === 'separator';
}

function appRoutesEqual(left: AppRoute, right: AppRoute) {
  if (left.view !== right.view) {
    return false;
  }

  if (left.view === 'workspace' && right.view === 'workspace') {
    return left.sidebar === right.sidebar;
  }

  return left.view === 'settings' && right.view === 'settings' && left.tab === right.tab;
}

function getCurrentAppRoute(navigation: AppNavigationState) {
  return navigation.entries[navigation.index] ?? DEFAULT_APP_ROUTE;
}

function getLastWorkspaceSidebar(entries: AppRoute[], index: number) {
  for (let cursor = Math.min(index, entries.length - 1); cursor >= 0; cursor -= 1) {
    const route = entries[cursor];
    if (route?.view === 'workspace') {
      return route.sidebar;
    }
  }

  return DEFAULT_WORKSPACE_SIDEBAR;
}

function getLastSettingsTab(entries: AppRoute[], index: number) {
  for (let cursor = Math.min(index, entries.length - 1); cursor >= 0; cursor -= 1) {
    const route = entries[cursor];
    if (route?.view === 'settings') {
      return route.tab;
    }
  }

  return DEFAULT_SETTINGS_TAB;
}

function loadPanelVisibilityState(): PanelVisibilityState {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_PANEL_VISIBILITY;
  }

  try {
    const stored = localStorage.getItem(PANEL_VISIBILITY_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_PANEL_VISIBILITY;
    }

    const parsed = JSON.parse(stored) as Partial<PanelVisibilityState>;
    return {
      leftPanelOpen: typeof parsed.leftPanelOpen === 'boolean' ? parsed.leftPanelOpen : DEFAULT_PANEL_VISIBILITY.leftPanelOpen,
      rightPanelOpen: typeof parsed.rightPanelOpen === 'boolean' ? parsed.rightPanelOpen : DEFAULT_PANEL_VISIBILITY.rightPanelOpen,
      bottomPanelOpen: typeof parsed.bottomPanelOpen === 'boolean' ? parsed.bottomPanelOpen : DEFAULT_PANEL_VISIBILITY.bottomPanelOpen,
    };
  } catch {
    return DEFAULT_PANEL_VISIBILITY;
  }
}

function savePanelVisibilityState(panelVisibility: PanelVisibilityState) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(PANEL_VISIBILITY_STORAGE_KEY, JSON.stringify(panelVisibility));
  } catch {
    // Ignore storage failures; panel state can safely fall back to defaults.
  }
}

function getAccentContrastColor(accentColor: string) {
  const hex = accentColor.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return '#ffffff';
  }

  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const yiq = (red * 299 + green * 587 + blue * 114) / 1000;

  return yiq >= 150 ? '#081018' : '#ffffff';
}

function isToolchainNotificationActive(notification: ToolchainNotification) {
  return notification.status === 'queued' || notification.status === 'running';
}

function getToolchainNotificationStatusLabel(notification: ToolchainNotification) {
  if (notification.status === 'success') {
    return 'Completed';
  }

  if (notification.status === 'error') {
    return 'Failed';
  }

  if (notification.status === 'canceled') {
    return 'Stopped';
  }

  if (notification.status === 'interrupted') {
    return 'Interrupted';
  }

  const phase = notification.phase.toLowerCase();
  if (phase.includes('download')) {
    return 'Downloading';
  }
  if (phase.includes('upload')) {
    return 'Uploading';
  }
  if (phase.includes('compil')) {
    return 'Compiling';
  }
  if (phase.includes('migrat')) {
    return 'Migrating';
  }
  if (phase.includes('remov')) {
    return 'Removing';
  }

  return notification.status === 'queued' ? 'Queued' : 'Running';
}

function formatTaskDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNotificationDebugData(notification: ToolchainNotification) {
  const createdAt = formatTaskDateTime(notification.createdAt);
  const updatedAt = formatTaskDateTime(notification.updatedAt);
  const metadata = JSON.stringify(notification.metadata, null, 2);
  const raw = JSON.stringify(notification, null, 2);

  return [
    'Tantalum IDE toolchain notification',
    `Title: ${notification.title}`,
    `Description: ${notification.detail || '(none)'}`,
    `Status: ${notification.status}`,
    `Kind: ${notification.kind}`,
    `Phase: ${notification.phase}`,
    `Name: ${notification.name || '(none)'}`,
    `Version: ${notification.version || '(none)'}`,
    `Target: ${notification.target || '(none)'}`,
    `Progress: ${notification.progress === null ? 'indeterminate' : `${notification.progress}%`}`,
    `Created: ${createdAt}`,
    `Updated: ${updatedAt}`,
    '',
    'Metadata:',
    metadata,
    '',
    'Raw notification:',
    raw,
  ].join('\n');
}

export function AppShell({ appName, version, platform, user, onSignedOut }: AppShellProps) {
  const [appNavigation, setAppNavigation] = useState<AppNavigationState>(() => ({
    entries: [DEFAULT_APP_ROUTE],
    index: 0,
  }));
  const [panelVisibility, setPanelVisibility] = useState<PanelVisibilityState>(() => loadPanelVisibilityState());
  const [workspaceTitle, setWorkspaceTitle] = useState('');
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(() => loadUiPreferences());
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() => resolveThemePreference(uiPreferences.theme));
  const [toolchainNotifications, setToolchainNotifications] = useState<ToolchainNotification[]>([]);
  const [notificationHistoryOpen, setNotificationHistoryOpen] = useState(false);
  const [restoreNotificationRequest, setRestoreNotificationRequest] = useState<ToolchainNotificationRestoreRequest | null>(null);
  const [copiedNotificationId, setCopiedNotificationId] = useState<string | null>(null);
  const restoreNotificationRequestCounterRef = useRef(1);
  const currentRoute = getCurrentAppRoute(appNavigation);
  const currentView = currentRoute.view;
  const currentWorkspaceSidebar =
    currentRoute.view === 'workspace' ? currentRoute.sidebar : getLastWorkspaceSidebar(appNavigation.entries, appNavigation.index);
  const currentSettingsTab = currentRoute.view === 'settings' ? currentRoute.tab : getLastSettingsTab(appNavigation.entries, appNavigation.index);
  const canNavigateBack = appNavigation.index > 0;
  const canNavigateForward = appNavigation.index < appNavigation.entries.length - 1;
  const workspaceSearchAvailable = currentView === 'workspace' && Boolean(workspaceTitle);
  const { leftPanelOpen, rightPanelOpen, bottomPanelOpen } = panelVisibility;
  const activeToolchainNotificationCount = useMemo(
    () => toolchainNotifications.filter(isToolchainNotificationActive).length,
    [toolchainNotifications],
  );

  useEffect(() => {
    savePanelVisibilityState(panelVisibility);
  }, [panelVisibility]);

  useEffect(() => {
    let disposed = false;

    void window.tantalum.notifications.list().then((result) => {
      if (!disposed && result.success) {
        setToolchainNotifications(result.notifications);
      }
    });

    const offNotifications = window.tantalum.notifications.onChanged((notifications) => {
      setToolchainNotifications(notifications);
    });

    return () => {
      disposed = true;
      offNotifications();
    };
  }, []);

  useEffect(() => {
    if (currentView !== 'workspace' || (currentWorkspaceSidebar !== 'git' && currentWorkspaceSidebar !== 'my-projects')) {
      return;
    }

    setPanelVisibility((current) => (current.rightPanelOpen ? current : { ...current, rightPanelOpen: true }));
  }, [currentView, currentWorkspaceSidebar]);

  useEffect(() => {
    saveUiPreferences(uiPreferences);
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');

    const applyPreferences = () => {
      const nextTheme = resolveThemePreference(uiPreferences.theme);
      setResolvedTheme(nextTheme);

      const root = document.documentElement;
      root.dataset.theme = nextTheme;
      root.dataset.themePreference = uiPreferences.theme;
      root.style.setProperty('--app-font-family', uiPreferences.fontFamily);
      root.style.setProperty('--app-font-size', `${uiPreferences.fontSize}px`);
      root.style.setProperty('--accent', uiPreferences.accentColor);
      root.style.setProperty('--accent-contrast', getAccentContrastColor(uiPreferences.accentColor));
      root.style.setProperty('--color-accent', uiPreferences.accentColor);
    };

    applyPreferences();
    mediaQuery.addEventListener('change', applyPreferences);

    return () => {
      mediaQuery.removeEventListener('change', applyPreferences);
    };
  }, [uiPreferences]);

  useEffect(() => {
    if (currentView !== 'workspace') {
      return;
    }

    const layoutHandle = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });

    return () => {
      window.cancelAnimationFrame(layoutHandle);
    };
  }, [currentView]);

  useEffect(() => {
    const handleWorkspaceSearchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        if (!workspaceSearchAvailable) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        setWorkspaceSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleWorkspaceSearchShortcut, true);
    return () => {
      window.removeEventListener('keydown', handleWorkspaceSearchShortcut, true);
    };
  }, [workspaceSearchAvailable]);

  const handlePreferenceChange = (nextPreferences: UiPreferences) => {
    setUiPreferences(normalizeUiPreferences(nextPreferences));
  };

  const restoreToolchainNotification = useCallback((notification: ToolchainNotification) => {
    if (!isToolchainNotificationActive(notification)) {
      return;
    }

    setRestoreNotificationRequest({
      requestId: restoreNotificationRequestCounterRef.current++,
      notification,
    });
  }, []);

  async function copyToolchainNotification(notification: ToolchainNotification) {
    try {
      await navigator.clipboard.writeText(formatNotificationDebugData(notification));
      setCopiedNotificationId(notification.id);
      window.setTimeout(() => {
        setCopiedNotificationId((current) => (current === notification.id ? null : current));
      }, 1600);
    } catch (error) {
      console.error('Unable to copy notification details:', error);
    }
  }

  const pushAppRoute = useCallback((nextRoute: AppRoute) => {
    setAppNavigation((current) => {
      const currentRoute = getCurrentAppRoute(current);
      if (appRoutesEqual(currentRoute, nextRoute)) {
        return current;
      }

      const pendingEntries = [...current.entries.slice(0, current.index + 1), nextRoute];
      const entries =
        pendingEntries.length > MAX_APP_HISTORY_ENTRIES ? pendingEntries.slice(pendingEntries.length - MAX_APP_HISTORY_ENTRIES) : pendingEntries;

      return {
        entries,
        index: entries.length - 1,
      };
    });
  }, []);

  const navigateBack = useCallback(() => {
    setAppNavigation((current) => (current.index > 0 ? { ...current, index: current.index - 1 } : current));
  }, []);

  const navigateForward = useCallback(() => {
    setAppNavigation((current) => (current.index < current.entries.length - 1 ? { ...current, index: current.index + 1 } : current));
  }, []);

  const navigateToWorkspaceSidebar = useCallback(
    (sidebar: SidebarView) => {
      pushAppRoute({ view: 'workspace', sidebar });
    },
    [pushAppRoute],
  );

  const navigateToSettings = useCallback(() => {
    pushAppRoute({ view: 'settings', tab: getLastSettingsTab(appNavigation.entries, appNavigation.index) });
  }, [appNavigation.entries, appNavigation.index, pushAppRoute]);

  const navigateToSettingsTab = useCallback(
    (tab: SettingsTab) => {
      pushAppRoute({ view: 'settings', tab });
    },
    [pushAppRoute],
  );

  const navigateToAgentSettings = useCallback(() => {
    navigateToSettingsTab('agent');
  }, [navigateToSettingsTab]);

  const navigateToLastWorkspace = useCallback(() => {
    pushAppRoute({ view: 'workspace', sidebar: getLastWorkspaceSidebar(appNavigation.entries, appNavigation.index) });
  }, [appNavigation.entries, appNavigation.index, pushAppRoute]);

  const setPanelOpen = useCallback((panel: keyof PanelVisibilityState, open: boolean) => {
    setPanelVisibility((current) => (current[panel] === open ? current : { ...current, [panel]: open }));
  }, []);

  const togglePanelOpen = useCallback((panel: keyof PanelVisibilityState) => {
    setPanelVisibility((current) => ({ ...current, [panel]: !current[panel] }));
  }, []);

  const handleRightPanelOpenChange = useCallback(
    (open: boolean) => {
      setPanelOpen('rightPanelOpen', open);
    },
    [setPanelOpen],
  );

  const handleBottomPanelOpenChange = useCallback(
    (open: boolean) => {
      setPanelOpen('bottomPanelOpen', open);
    },
    [setPanelOpen],
  );

  const handleSignedOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error(error);
    } finally {
      onSignedOut();
    }
  };

  return (
    <div className="app-shell-container no-global-sidebar">
      <AppTitleBar
        appName={appName}
        version={version}
        titleText={currentView === 'settings' ? 'Settings' : workspaceTitle || 'No Project open'}
        user={user}
        view={currentView}
        leftPanelOpen={leftPanelOpen}
        rightPanelOpen={rightPanelOpen}
        bottomPanelOpen={bottomPanelOpen}
        workspaceSearchAvailable={workspaceSearchAvailable}
        workspaceSearchOpen={workspaceSearchOpen}
        toolchainNotifications={toolchainNotifications}
        activeToolchainNotificationCount={activeToolchainNotificationCount}
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onNavigateBack={navigateBack}
        onNavigateForward={navigateForward}
        onBackToWorkspace={navigateToLastWorkspace}
        onOpenSettings={navigateToSettings}
        onOpenToolchainNotificationHistory={() => setNotificationHistoryOpen(true)}
        onRestoreToolchainNotification={restoreToolchainNotification}
        onOpenWorkspaceSearch={() => setWorkspaceSearchOpen(true)}
        onToggleLeftPanel={() => togglePanelOpen('leftPanelOpen')}
        onToggleRightPanel={() => togglePanelOpen('rightPanelOpen')}
        onToggleBottomPanel={() => togglePanelOpen('bottomPanelOpen')}
        onSignedOut={() => void handleSignedOut()}
      />

      <main className="app-shell-main">
        <div
          className={`app-view-panel ${currentView === 'workspace' ? 'app-view-panel-active' : 'app-view-panel-hidden'}`}
          aria-hidden={currentView !== 'workspace'}
        >
          <IDEWorkspace
            active={currentView === 'workspace'}
            appName={appName}
            version={version}
            platform={platform}
            user={user}
            onSignedOut={() => void handleSignedOut()}
            onOpenSettings={navigateToSettings}
            onOpenAgentSettings={navigateToAgentSettings}
            sidebar={currentWorkspaceSidebar}
            onSidebarChange={navigateToWorkspaceSidebar}
            leftPanelOpen={leftPanelOpen}
            rightPanelOpen={rightPanelOpen}
            onRightPanelOpenChange={handleRightPanelOpenChange}
            bottomPanelOpen={bottomPanelOpen}
            onBottomPanelOpenChange={handleBottomPanelOpenChange}
            onWorkspaceTitleChange={setWorkspaceTitle}
            workspaceSearchOpen={workspaceSearchOpen}
            onWorkspaceSearchOpenChange={setWorkspaceSearchOpen}
            uiPreferences={uiPreferences}
            resolvedTheme={resolvedTheme}
            restoreToolchainNotificationRequest={restoreNotificationRequest}
          />
        </div>
        {currentView === 'settings' && (
          <div className="app-view-panel app-view-panel-active">
            <SettingsPage
              appName={appName}
              version={version}
              user={user}
              preferences={uiPreferences}
              activeTab={currentSettingsTab}
              onActiveTabChange={navigateToSettingsTab}
              onPreferencesChange={handlePreferenceChange}
              onResetPreferences={() => handlePreferenceChange(DEFAULT_UI_PREFERENCES)}
            />
          </div>
        )}
      </main>

      <Modal
        open={notificationHistoryOpen}
        title="Toolchain notifications"
        subtitle="Current and completed toolchain tasks."
        size="lg"
        onClose={() => setNotificationHistoryOpen(false)}
      >
        {toolchainNotifications.length ? (
          <div className="library-install-history-list">
            {toolchainNotifications.map((notification) => (
              <article
                key={notification.id}
                className={`library-install-history-item library-install-${notification.status}`}
              >
                <span className="library-install-history-icon">
                  {notification.status === 'success' ? <CheckCircle2 size={16} /> : notification.status === 'error' ? <AlertCircle size={16} /> : notification.status === 'canceled' || notification.status === 'interrupted' ? <X size={16} /> : <LoaderCircle size={16} className="spin" />}
                </span>
                <button
                  className="library-install-history-main"
                  type="button"
                  disabled={!isToolchainNotificationActive(notification)}
                  onClick={() => restoreToolchainNotification(notification)}
                >
                  <div>
                    <strong>{notification.title}</strong>
                    <span>{getToolchainNotificationStatusLabel(notification)}</span>
                  </div>
                  <p>{notification.target || notification.version || notification.kind}</p>
                  {notification.detail ? <small>{notification.detail}</small> : null}
                  {isToolchainNotificationActive(notification) ? (
                    <div className={`library-install-progress ${notification.progress === null ? 'library-install-progress-indeterminate' : ''}`}>
                      <span style={notification.progress === null ? undefined : { width: `${notification.progress}%` }} />
                    </div>
                  ) : null}
                </button>
                <div className="library-install-history-side">
                  <button
                    className="icon-button library-install-copy-button"
                    type="button"
                    onClick={() => void copyToolchainNotification(notification)}
                    title={copiedNotificationId === notification.id ? 'Copied notification details' : 'Copy notification details'}
                    aria-label={copiedNotificationId === notification.id ? 'Copied notification details' : 'Copy notification details'}
                  >
                    {copiedNotificationId === notification.id ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  </button>
                  <time>{formatTaskDateTime(notification.updatedAt)}</time>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="library-install-history-empty">
            <Download size={22} />
            <span>No toolchain notifications yet.</span>
          </div>
        )}
      </Modal>
    </div>
  );
}

function AppTitleBar({
  titleText,
  user,
  view,
  leftPanelOpen,
  rightPanelOpen,
  bottomPanelOpen,
  workspaceSearchAvailable,
  workspaceSearchOpen,
  toolchainNotifications,
  activeToolchainNotificationCount,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
  onBackToWorkspace,
  onOpenSettings,
  onOpenToolchainNotificationHistory,
  onRestoreToolchainNotification,
  onOpenWorkspaceSearch,
  onToggleLeftPanel,
  onToggleRightPanel,
  onToggleBottomPanel,
  onSignedOut,
}: {
  appName: string;
  version: string;
  titleText: string;
  user: Models.User<Models.Preferences>;
  view: View;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  workspaceSearchAvailable: boolean;
  workspaceSearchOpen: boolean;
  toolchainNotifications: ToolchainNotification[];
  activeToolchainNotificationCount: number;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onBackToWorkspace: () => void;
  onOpenSettings: () => void;
  onOpenToolchainNotificationHistory: () => void;
  onRestoreToolchainNotification: (notification: ToolchainNotification) => void;
  onOpenWorkspaceSearch: () => void;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  onToggleBottomPanel: () => void;
  onSignedOut: () => void;
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [libraryNotificationOpen, setLibraryNotificationOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<TitlebarMenuId | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const libraryNotificationRef = useRef<HTMLDivElement | null>(null);
  const titlebarMenuRef = useRef<HTMLElement | null>(null);
  const displayName = user.name || user.email || 'Account';
  const initial = useMemo(() => displayName.trim().charAt(0).toUpperCase() || 'T', [displayName]);
  const recentToolchainNotifications = useMemo(() => toolchainNotifications.slice(0, 3), [toolchainNotifications]);

  useEffect(() => {
    if (!accountMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!libraryNotificationOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (libraryNotificationRef.current && !libraryNotificationRef.current.contains(event.target as Node)) {
        setLibraryNotificationOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [libraryNotificationOpen]);

  useEffect(() => {
    void refreshRecentItems();
  }, []);

  useEffect(() => {
    if (!openMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (titlebarMenuRef.current && !titlebarMenuRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  async function refreshRecentItems() {
    const [workspaceResult, fileResult] = await Promise.all([
      window.tantalum.fs.getRecentWorkspaces(),
      window.tantalum.fs.getRecentFiles(),
    ]);

    if (workspaceResult.success) {
      setRecentWorkspaces(workspaceResult.paths);
    }

    if (fileResult.success) {
      setRecentFiles(fileResult.paths);
    }
  }

  const controlWindow = (action: WindowControlAction) => {
    void window.tantalum.app.controlWindow(action);
  };

  const closeMenus = () => {
    setOpenMenu(null);
    setAccountMenuOpen(false);
    setLibraryNotificationOpen(false);
  };

  const sendMenuAction = (action: MenuAction) => {
    closeMenus();
    void window.tantalum.app.dispatchMenuAction(action);
  };

  const runMenuCommand = (command: () => void) => {
    closeMenus();
    command();
  };

  const openMenuExternalLink = (url: string) => {
    closeMenus();
    void window.tantalum.shell.openExternal(url);
  };

  const toggleMenu = (menuId: TitlebarMenuId) => {
    setAccountMenuOpen(false);
    setLibraryNotificationOpen(false);
    setOpenMenu((current) => {
      const next = current === menuId ? null : menuId;
      if (next === 'file') {
        void refreshRecentItems();
      }
      return next;
    });
  };

  const switchOpenMenu = (menuId: TitlebarMenuId) => {
    if (!openMenu || openMenu === menuId) {
      return;
    }

    if (menuId === 'file') {
      void refreshRecentItems();
    }
    setOpenMenu(menuId);
  };

  const recentWorkspaceItems: TitlebarMenuItem[] = recentWorkspaces.length
    ? recentWorkspaces.map((folderPath) => ({
        id: `recent-workspace:${folderPath}`,
        label: baseNameFromPath(folderPath),
        title: folderPath,
        action: { type: 'open-recent-workspace', folderPath },
      }))
    : [{ id: 'recent-workspaces-empty', label: 'No Recent Projects', disabled: true }];

  const recentFileItems: TitlebarMenuItem[] = recentFiles.length
    ? recentFiles.map((filePath) => ({
        id: `recent-file:${filePath}`,
        label: baseNameFromPath(filePath),
        title: filePath,
        action: { type: 'open-recent-file', filePath },
      }))
    : [{ id: 'recent-files-empty', label: 'No Recent Files', disabled: true }];

  const menuGroups: TitlebarMenuGroup[] = [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'new-file', label: 'New File', shortcut: 'Ctrl N', action: { type: 'new-file' } },
        { id: 'open-file', label: 'Open File...', shortcut: 'Ctrl O', action: { type: 'open-file' } },
        { id: 'open-folder', label: 'Open Project...', shortcut: 'Ctrl Shift O', action: { type: 'open-folder' } },
        {
          id: 'open-recent',
          label: 'Open Recent',
          submenu: [
            { id: 'recent-folders', label: 'Projects', submenu: recentWorkspaceItems },
            { id: 'recent-files', label: 'Files', submenu: recentFileItems },
          ],
        },
        {
          id: 'examples',
          label: 'Examples',
          submenu: [
            { id: 'example-blink', label: 'Blink', action: { type: 'load-example', name: 'Blink', content: `// Blink
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}` } },
            { id: 'example-bare-minimum', label: 'Bare Minimum', action: { type: 'load-example', name: 'BareMinimum', content: `void setup() {
  // put your setup code here, to run once:
}

void loop() {
  // put your main code here, to run repeatedly:
}` } },
            { id: 'example-analog-read', label: 'Analog Read Serial', action: { type: 'load-example', name: 'AnalogReadSerial', content: `int sensorValue = 0;

void setup() {
  Serial.begin(9600);
}

void loop() {
  sensorValue = analogRead(A0);
  Serial.println(sensorValue);
  delay(100);
}` } },
          ],
        },
        { id: 'file-save-separator', type: 'separator' },
        { id: 'save-file', label: 'Save', shortcut: 'Ctrl S', action: { type: 'save-file' } },
        { id: 'save-file-as', label: 'Save As...', shortcut: 'Ctrl Shift S', action: { type: 'save-file-as' } },
        { id: 'file-location-separator', type: 'separator' },
        { id: 'show-sketch-folder', label: 'Reveal in File Explorer', shortcut: 'Ctrl K', action: { type: 'show-sketch-folder' } },
        { id: 'file-exit-separator', type: 'separator' },
        { id: 'exit', label: 'Exit', onSelect: () => controlWindow('close') },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { id: 'undo', label: 'Undo', shortcut: 'Ctrl Z', action: { type: 'undo' } },
        { id: 'redo', label: 'Redo', shortcut: 'Ctrl Y', action: { type: 'redo' } },
        { id: 'edit-clipboard-separator', type: 'separator' },
        { id: 'cut', label: 'Cut', shortcut: 'Ctrl X', action: { type: 'cut' } },
        { id: 'copy', label: 'Copy', shortcut: 'Ctrl C', action: { type: 'copy' } },
        { id: 'paste', label: 'Paste', shortcut: 'Ctrl V', action: { type: 'paste' } },
        { id: 'select-all', label: 'Select All', shortcut: 'Ctrl A', action: { type: 'select-all' } },
        { id: 'edit-search-separator', type: 'separator' },
        { id: 'find', label: 'Find', shortcut: 'Ctrl F', action: { type: 'find' } },
        { id: 'find-workspace', label: 'Find in Files', shortcut: 'Ctrl Shift F', disabled: !workspaceSearchAvailable, action: { type: 'find-in-workspace' } },
        { id: 'find-next', label: 'Find Next', shortcut: 'Ctrl G', action: { type: 'find-next' } },
        { id: 'find-previous', label: 'Find Previous', shortcut: 'Ctrl Shift G', action: { type: 'find-previous' } },
        { id: 'edit-code-separator', type: 'separator' },
        { id: 'toggle-comment', label: 'Comment / Uncomment', shortcut: 'Ctrl /', action: { type: 'toggle-comment' } },
        { id: 'format-document', label: 'Format Document', shortcut: 'Ctrl T', action: { type: 'format-document' } },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'show-explorer', label: 'Explorer', action: { type: 'show-explorer' } },
        { id: 'show-boards', label: 'Boards', action: { type: 'show-boards' } },
        { id: 'show-libraries', label: 'Libraries', action: { type: 'show-libraries' } },
        { id: 'show-git', label: 'Git', action: { type: 'show-git' } },
        { id: 'show-platforms', label: 'Board Platforms', action: { type: 'show-platforms' } },
        { id: 'view-panels-separator', type: 'separator' },
        { id: 'toggle-left-panel', label: leftPanelOpen ? 'Hide Left Panel' : 'Show Left Panel', onSelect: onToggleLeftPanel },
        { id: 'toggle-right-panel', label: rightPanelOpen ? 'Hide Right Panel' : 'Show Right Panel', onSelect: onToggleRightPanel },
        { id: 'toggle-bottom-panel', label: bottomPanelOpen ? 'Hide Bottom Panel' : 'Show Bottom Panel', onSelect: onToggleBottomPanel },
        { id: 'show-output', label: 'Output', action: { type: 'show-output' } },
        { id: 'show-terminal', label: 'Terminal', shortcut: 'Ctrl Shift M', action: { type: 'toggle-terminal' } },
        { id: 'show-serial-monitor', label: 'Serial Monitor', action: { type: 'show-serial-monitor' } },
        { id: 'show-my-projects', label: 'My Projects', action: { type: 'show-my-projects' } },
        { id: 'view-settings-separator', type: 'separator' },
        { id: 'settings', label: 'Settings', onSelect: onOpenSettings },
      ],
    },
    {
      id: 'sketch',
      label: 'Project',
      items: [
        { id: 'compile', label: 'Verify / Compile', shortcut: 'Ctrl R', action: { type: 'compile' } },
        { id: 'upload', label: 'Upload', shortcut: 'Ctrl U', action: { type: 'upload-local' } },
        { id: 'sketch-tools-separator', type: 'separator' },
        { id: 'manage-libraries', label: 'Manage Libraries...', action: { type: 'open-library-manager' } },
        { id: 'boards-manager', label: 'Boards Manager...', action: { type: 'open-board-manager' } },
        { id: 'install-esp32', label: 'Install ESP32 Support', action: { type: 'install-esp32-support' } },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        { id: 'getting-started', label: 'Getting Started', onSelect: () => openMenuExternalLink('https://docs.arduino.cc/learn/starting-guide/getting-started-arduino') },
        { id: 'arduino-reference', label: 'Arduino Reference', onSelect: () => openMenuExternalLink('https://www.arduino.cc/reference/en/') },
        { id: 'help-about-separator', type: 'separator' },
        { id: 'about', label: 'About Tantalum IDE', action: { type: 'about' } },
      ],
    },
  ];

  const renderMenuItems = (items: TitlebarMenuItem[]) =>
    items.map((item) => {
      if (isMenuSeparator(item)) {
        return <div key={item.id} className="titlebar-menu-separator" role="separator" />;
      }

      const hasSubmenu = Boolean(item.submenu?.length);

      return (
        <div key={item.id} className={`titlebar-menu-row ${hasSubmenu ? 'has-submenu' : ''}`} role="none">
          <button
            type="button"
            role="menuitem"
            title={item.title}
            disabled={item.disabled}
            aria-haspopup={hasSubmenu ? 'menu' : undefined}
            onClick={() => {
              if (item.disabled || hasSubmenu) {
                return;
              }

              if (item.action) {
                sendMenuAction(item.action);
                return;
              }

              if (item.onSelect) {
                runMenuCommand(item.onSelect);
              }
            }}
          >
            <span className="titlebar-menu-label">{item.label}</span>
            {item.shortcut ? <span className="titlebar-menu-shortcut">{item.shortcut}</span> : <span />}
            {hasSubmenu ? <ChevronRight size={13} /> : null}
          </button>
          {hasSubmenu ? (
            <div className="titlebar-submenu-panel" role="menu">
              {renderMenuItems(item.submenu ?? [])}
            </div>
          ) : null}
        </div>
      );
    });

  return (
    <header className="app-titlebar flex h-[44px] items-center border-b">
      <div className="titlebar-left">
        <button
          className={`titlebar-icon-button ${leftPanelOpen ? 'active' : ''}`}
          type="button"
          onClick={onToggleLeftPanel}
          title={leftPanelOpen ? 'Close left panel' : 'Open left panel'}
          aria-pressed={leftPanelOpen}
        >
          <PanelLeft size={16} />
        </button>
        <button
          className={`titlebar-icon-button ${canNavigateBack ? '' : 'muted'}`}
          type="button"
          onClick={onNavigateBack}
          title="Back"
          aria-label="Back"
          disabled={!canNavigateBack}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className={`titlebar-icon-button ${canNavigateForward ? '' : 'muted'}`}
          type="button"
          onClick={onNavigateForward}
          title="Forward"
          aria-label="Forward"
          disabled={!canNavigateForward}
        >
          <ArrowRight size={16} />
        </button>
        {view === 'settings' ? (
          <button className="titlebar-menu-item" type="button" onClick={onBackToWorkspace}>
            <ChevronLeft size={14} />
            Back to app
          </button>
        ) : null}
        <nav className="titlebar-menu" ref={titlebarMenuRef} aria-label="Application menu" role="menubar">
          {menuGroups.map((menu) => (
            <div key={menu.id} className="titlebar-menu-group" role="none" onPointerEnter={() => switchOpenMenu(menu.id)}>
              <button
                className={`titlebar-menu-trigger ${openMenu === menu.id ? 'active' : ''}`}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openMenu === menu.id}
                onClick={() => toggleMenu(menu.id)}
              >
                {menu.label}
              </button>
              {openMenu === menu.id ? (
                <div className="titlebar-menu-dropdown" role="menu">
                  {renderMenuItems(menu.items)}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
      </div>

      <div className="titlebar-drag-region" onDoubleClick={() => controlWindow('maximize')}>
        {view === 'workspace' ? (
          <button
            className={`titlebar-search-pill ${workspaceSearchOpen ? 'active' : ''}`}
            type="button"
            onClick={onOpenWorkspaceSearch}
            disabled={!workspaceSearchAvailable}
            title={workspaceSearchAvailable ? 'Search Project' : 'Open a Project to search'}
            aria-haspopup="dialog"
            aria-expanded={workspaceSearchOpen}
          >
            <Search size={14} />
            <span>{workspaceSearchAvailable ? `Search ${titleText}` : 'Open Project to search'}</span>
            <kbd>Ctrl Shift F</kbd>
          </button>
        ) : (
          <span>{titleText}</span>
        )}
      </div>

      <div className="titlebar-right">
        <button
          className={`titlebar-icon-button ${bottomPanelOpen ? 'active' : ''}`}
          type="button"
          onClick={onToggleBottomPanel}
          title={bottomPanelOpen ? 'Close bottom panel' : 'Open bottom panel'}
          aria-pressed={bottomPanelOpen}
        >
          <PanelBottom size={15} />
        </button>
        <button
          className={`titlebar-icon-button ${rightPanelOpen ? 'active' : ''}`}
          type="button"
          onClick={onToggleRightPanel}
          title={rightPanelOpen ? 'Close right panel' : 'Open right panel'}
          aria-pressed={rightPanelOpen}
        >
          <PanelRight size={16} />
        </button>
        <button
          className={`titlebar-icon-button ${view === 'settings' ? 'active' : ''}`}
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          aria-pressed={view === 'settings'}
        >
          <Settings size={15} />
        </button>
        <div className="library-notification-menu" ref={libraryNotificationRef}>
          <button
            className={`titlebar-icon-button library-notification-trigger ${libraryNotificationOpen ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setOpenMenu(null);
              setAccountMenuOpen(false);
              setLibraryNotificationOpen((current) => !current);
            }}
            title="Toolchain notifications"
            aria-haspopup="menu"
            aria-expanded={libraryNotificationOpen}
          >
            <Bell size={15} />
            {activeToolchainNotificationCount > 0 ? <span className="library-notification-badge">{activeToolchainNotificationCount}</span> : null}
          </button>
          {libraryNotificationOpen ? (
            <div className="library-notification-dropdown" role="menu">
              <div className="library-notification-head">
                <strong>Toolchain</strong>
                <span>{activeToolchainNotificationCount > 0 ? `${activeToolchainNotificationCount} active` : `${toolchainNotifications.length} total`}</span>
              </div>
              {recentToolchainNotifications.length ? (
                <div className="library-notification-list">
                  {recentToolchainNotifications.map((notification) => (
                    <button
                      key={notification.id}
                      className={`library-notification-item library-install-${notification.status}`}
                      type="button"
                      disabled={!isToolchainNotificationActive(notification)}
                      onClick={() => {
                        onRestoreToolchainNotification(notification);
                        setLibraryNotificationOpen(false);
                      }}
                    >
                      <span className="library-notification-status">
                        {notification.status === 'success' ? <CheckCircle2 size={15} /> : notification.status === 'error' ? <AlertCircle size={15} /> : notification.status === 'canceled' || notification.status === 'interrupted' ? <X size={15} /> : <LoaderCircle size={15} className="spin" />}
                      </span>
                      <div>
                        <div className="library-notification-title-row">
                          <strong>{notification.title}</strong>
                          <span>{getToolchainNotificationStatusLabel(notification)}</span>
                        </div>
                        <p>{notification.target || notification.version || notification.kind}</p>
                        {isToolchainNotificationActive(notification) ? (
                          <div className={`library-install-progress ${notification.progress === null ? 'library-install-progress-indeterminate' : ''}`}>
                            <span style={notification.progress === null ? undefined : { width: `${notification.progress}%` }} />
                          </div>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="library-notification-empty">
                  <Download size={18} />
                  <span>No toolchain notifications yet.</span>
                </div>
              )}
              <button
                className="library-notification-view-all"
                type="button"
                onClick={() => {
                  setLibraryNotificationOpen(false);
                  onOpenToolchainNotificationHistory();
                }}
              >
                View all
              </button>
            </div>
          ) : null}
        </div>
        <div className="account-menu" ref={accountMenuRef}>
          <button
            className={`account-menu-trigger ${accountMenuOpen ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setOpenMenu(null);
              setLibraryNotificationOpen(false);
              setAccountMenuOpen((current) => !current);
            }}
            title={displayName}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
          >
            <span className="account-avatar">{initial}</span>
            <ChevronDown size={13} />
          </button>
          {accountMenuOpen ? (
            <div className="account-dropdown" role="menu">
              <div className="account-dropdown-head">
                <UserRound size={15} />
                <div>
                  <strong>{displayName}</strong>
                  <span>{user.email}</span>
                </div>
              </div>
              <button type="button" role="menuitem" onClick={onSignedOut}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>

        <div className="window-controls" aria-label="Window controls">
          <button className="window-control-button" type="button" onClick={() => controlWindow('minimize')} title="Minimize">
            <Minus size={14} />
          </button>
          <button className="window-control-button" type="button" onClick={() => controlWindow('maximize')} title="Maximize">
            <Maximize2 size={13} />
          </button>
          <button className="window-control-button window-control-close" type="button" onClick={() => controlWindow('close')} title="Close">
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
