import { useEffect, useMemo, useRef, useState } from 'react';
import type { Models } from 'appwrite';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  Maximize2,
  Minus,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Settings,
  UserRound,
  X,
} from 'lucide-react';

import { signOut } from '@/lib/auth';
import {
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  normalizeUiPreferences,
  resolveThemePreference,
  saveUiPreferences,
  type UiPreferences,
} from '@/lib/uiPreferences';

import { IDEWorkspace } from './IDEWorkspace';
import { SettingsPage } from './SettingsPage';

type AppShellProps = {
  appName: string;
  version: string;
  user: Models.User<Models.Preferences>;
  onSignedOut: () => void;
};

type View = 'workspace' | 'settings';
type WindowControlAction = 'minimize' | 'maximize' | 'close';

export function AppShell({ appName, version, user, onSignedOut }: AppShellProps) {
  const [currentView, setCurrentView] = useState<View>('workspace');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [workspaceTitle, setWorkspaceTitle] = useState('');
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(() => loadUiPreferences());
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() => resolveThemePreference(uiPreferences.theme));

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
      root.style.setProperty('--color-accent', uiPreferences.accentColor);
    };

    applyPreferences();
    mediaQuery.addEventListener('change', applyPreferences);

    return () => {
      mediaQuery.removeEventListener('change', applyPreferences);
    };
  }, [uiPreferences]);

  const handlePreferenceChange = (nextPreferences: UiPreferences) => {
    setUiPreferences(normalizeUiPreferences(nextPreferences));
  };

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
        titleText={currentView === 'settings' ? 'Settings' : workspaceTitle || 'No folder open'}
        user={user}
        view={currentView}
        leftPanelOpen={leftPanelOpen}
        rightPanelOpen={rightPanelOpen}
        bottomPanelOpen={bottomPanelOpen}
        onBackToWorkspace={() => setCurrentView('workspace')}
        onOpenSettings={() => setCurrentView('settings')}
        onToggleLeftPanel={() => setLeftPanelOpen((current) => !current)}
        onToggleRightPanel={() => setRightPanelOpen((current) => !current)}
        onToggleBottomPanel={() => setBottomPanelOpen((current) => !current)}
        onSignedOut={() => void handleSignedOut()}
      />

      <main className="app-shell-main">
        {currentView === 'workspace' && (
          <IDEWorkspace
            appName={appName}
            version={version}
            user={user}
            onSignedOut={() => void handleSignedOut()}
            onOpenSettings={() => setCurrentView('settings')}
            leftPanelOpen={leftPanelOpen}
            rightPanelOpen={rightPanelOpen}
            bottomPanelOpen={bottomPanelOpen}
            onBottomPanelOpenChange={setBottomPanelOpen}
            onWorkspaceTitleChange={setWorkspaceTitle}
            uiPreferences={uiPreferences}
            resolvedTheme={resolvedTheme}
          />
        )}
        {currentView === 'settings' && (
          <SettingsPage
            appName={appName}
            version={version}
            user={user}
            preferences={uiPreferences}
            onPreferencesChange={handlePreferenceChange}
            onResetPreferences={() => handlePreferenceChange(DEFAULT_UI_PREFERENCES)}
          />
        )}
      </main>
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
  onBackToWorkspace,
  onOpenSettings,
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
  onBackToWorkspace: () => void;
  onOpenSettings: () => void;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  onToggleBottomPanel: () => void;
  onSignedOut: () => void;
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const displayName = user.name || user.email || 'Account';
  const initial = useMemo(() => displayName.trim().charAt(0).toUpperCase() || 'T', [displayName]);

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

  const controlWindow = (action: WindowControlAction) => {
    void window.tantalum.app.controlWindow(action);
  };

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
        <button className="titlebar-icon-button muted" type="button" title="Back" disabled>
          <ArrowLeft size={16} />
        </button>
        <button className="titlebar-icon-button muted" type="button" title="Forward" disabled>
          <ArrowRight size={16} />
        </button>
        {view === 'settings' ? (
          <button className="titlebar-menu-item" type="button" onClick={onBackToWorkspace}>
            <ChevronLeft size={14} />
            Back to app
          </button>
        ) : null}
        <nav className="titlebar-menu" aria-label="Application menu">
          {['File', 'Edit', 'View', 'Window', 'Help'].map((label) => (
            <button key={label} type="button">
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="titlebar-drag-region" onDoubleClick={() => controlWindow('maximize')}>
        <span>{titleText}</span>
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
        <div className="account-menu" ref={accountMenuRef}>
          <button
            className={`account-menu-trigger ${accountMenuOpen ? 'active' : ''}`}
            type="button"
            onClick={() => setAccountMenuOpen((current) => !current)}
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
