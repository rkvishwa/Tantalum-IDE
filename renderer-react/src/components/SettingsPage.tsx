import { useEffect, useRef, useState } from 'react';
import type { Models } from 'appwrite';
import { AlertTriangle, ChevronLeft, ChevronRight, Code2, Cpu, Download, FolderInput, FolderOpen, GitBranch, KeyRound, LoaderCircle, Monitor, Moon, Palette, RefreshCcw, RotateCcw, Save, Sun, Type, X } from 'lucide-react';

import { deleteBoard, listBoards } from '@/lib/boards';
import { hasRequiredCloudConfiguration } from '@/lib/config';
import type { BoardDocument } from '@/lib/models';
import { ACCENT_PRESETS, FONT_FAMILY_OPTIONS, type ThemePreference, type UiPreferences } from '@/lib/uiPreferences';
import { calculateBoardStatus } from '@/lib/utils';
import type { ArduinoLibraryDirectoryInfo, ArduinoStorageInfo, GitConfiguration, GitProvider, LibraryMigrationProgressEvent, LibraryMigrationResult } from '@/types/electron';

import { AgentPanel } from './AgentPanel';
import { BoardsHubToggle } from './BoardsHubControls';
import { useConfirm } from './ConfirmProvider';

type SettingsToast = {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
};

type SettingsPageProps = {
  appName: string;
  version: string;
  user: Models.User<Models.Preferences>;
  preferences: UiPreferences;
  activeTab: SettingsTab;
  onActiveTabChange: (tab: SettingsTab) => void;
  onPreferencesChange: (preferences: UiPreferences) => void;
  onResetPreferences: () => void;
  onBackToWorkspace: () => void;
};

export type SettingsTab = 'appearance' | 'editor' | 'agent' | 'git' | 'arduino' | 'boards';

const EMPTY_GIT_CONFIGURATION: GitConfiguration = {
  defaultProvider: 'github',
  githubUsername: '',
  gitlabUsername: '',
  gitUserName: '',
  gitUserEmail: '',
  githubTokenConfigured: false,
  gitlabTokenConfigured: false,
};

export function SettingsPage({
  appName,
  version,
  user,
  preferences,
  activeTab,
  onActiveTabChange,
  onPreferencesChange,
  onResetPreferences,
  onBackToWorkspace,
}: SettingsPageProps) {
  const { confirm } = useConfirm();
  const toastCounterRef = useRef(0);
  const [toasts, setToasts] = useState<SettingsToast[]>([]);
  const [boards, setBoards] = useState<BoardDocument[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [boardsError, setBoardsError] = useState('');
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [gitConfiguration, setGitConfiguration] = useState<GitConfiguration>(EMPTY_GIT_CONFIGURATION);
  const [gitConfigMessage, setGitConfigMessage] = useState('');
  const [gitConfigError, setGitConfigError] = useState('');
  const [gitTokenInputs, setGitTokenInputs] = useState({ githubToken: '', gitlabToken: '' });
  const [arduinoStorageInfo, setArduinoStorageInfo] = useState<ArduinoStorageInfo | null>(null);
  const [arduinoStorageMessage, setArduinoStorageMessage] = useState('');
  const [libraryDirectoryInfo, setLibraryDirectoryInfo] = useState<ArduinoLibraryDirectoryInfo | null>(null);
  const [libraryDirectoryError, setLibraryDirectoryError] = useState('');
  const [libraryMigrationMessage, setLibraryMigrationMessage] = useState('');
  const [libraryMigrationError, setLibraryMigrationError] = useState('');
  const [libraryMigrationProgress, setLibraryMigrationProgress] = useState<LibraryMigrationProgressEvent | null>(null);
  const [libraryMigrationResult, setLibraryMigrationResult] = useState<LibraryMigrationResult | null>(null);

  const selectedBoard = boards.find((board) => board.$id === selectedBoardId) ?? null;

  function pushToast(message: string, tone: SettingsToast['tone'] = 'info') {
    const id = toastCounterRef.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4000);
  }

  function dismissToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function updatePreferences(nextPreferences: Partial<UiPreferences>) {
    onPreferencesChange({ ...preferences, ...nextPreferences });
  }

  function renderToggleSetting(key: keyof UiPreferences, title: string, description: string) {
    return (
      <div className="settings-toggle-row">
        <BoardsHubToggle
          checked={Boolean(preferences[key])}
          label={title}
          description={description}
          onChange={(checked) => updatePreferences({ [key]: checked } as Partial<UiPreferences>)}
        />
      </div>
    );
  }

  async function refreshBoardsList() {
    if (!hasRequiredCloudConfiguration()) {
      setBoardsError('Cloud configuration is incomplete.');
      setBoardsLoading(false);
      return;
    }

    setBoardsLoading(true);
    setBoardsError('');

    try {
      const nextBoards = await listBoards({ bypassCache: true });
      setBoards(nextBoards);
      setSelectedBoardId((current) => {
        if (!current && nextBoards.length > 0) {
          return nextBoards[0].$id;
        }
        if (current && !nextBoards.some((board) => board.$id === current)) {
          return nextBoards[0]?.$id ?? '';
        }
        return current;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load boards.';
      setBoardsError(message);
      pushToast(message, 'error');
    } finally {
      setBoardsLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab !== 'boards') {
      return;
    }

    void refreshBoardsList();
  }, [activeTab]);

  async function refreshGitConfiguration() {
    const result = await window.tantalum.git.getConfiguration();
    if (result.success) {
      setGitConfiguration(result.config);
      setGitConfigError('');
      return;
    }

    setGitConfigError(result.error);
  }

  async function handleSaveGitConfiguration(options: { clearGithubToken?: boolean; clearGitlabToken?: boolean } = {}) {
    setBusyAction('save-git-config');
    setGitConfigMessage('');
    setGitConfigError('');

    const result = await window.tantalum.git.setConfiguration({
      defaultProvider: gitConfiguration.defaultProvider,
      githubUsername: gitConfiguration.githubUsername,
      gitlabUsername: gitConfiguration.gitlabUsername,
      gitUserName: gitConfiguration.gitUserName,
      gitUserEmail: gitConfiguration.gitUserEmail,
      githubToken: gitTokenInputs.githubToken,
      gitlabToken: gitTokenInputs.gitlabToken,
      clearGithubToken: options.clearGithubToken,
      clearGitlabToken: options.clearGitlabToken,
    });

    if (result.success) {
      setGitConfiguration(result.config);
      setGitTokenInputs({ githubToken: '', gitlabToken: '' });
      setGitConfigMessage('Git configuration saved.');
    } else {
      setGitConfigError(result.error);
    }

    setBusyAction(null);
  }

  function updateGitConfiguration(nextConfiguration: Partial<GitConfiguration>) {
    setGitConfiguration((current) => ({ ...current, ...nextConfiguration }));
  }

  useEffect(() => {
    if (activeTab !== 'git') {
      return;
    }

    void refreshGitConfiguration();
  }, [activeTab]);

  async function refreshArduinoLibraryDirectory() {
    const result = await window.tantalum.toolchain.getLibraryDirectory();
    if (result.success) {
      setLibraryDirectoryInfo(result);
      setLibraryDirectoryError('');
      return result;
    }

    setLibraryDirectoryError(result.error);
    return null;
  }

  async function refreshArduinoStorage() {
    const result = await window.tantalum.toolchain.getArduinoStorage();
    if (result.success) {
      setArduinoStorageInfo(result);
      setLibraryDirectoryError('');
      return result;
    }

    setLibraryDirectoryError(result.error);
    return null;
  }

  useEffect(() => {
    if (activeTab !== 'arduino') {
      return;
    }

    void refreshArduinoStorage();
    void refreshArduinoLibraryDirectory();
  }, [activeTab]);

  useEffect(() => {
    return window.tantalum.toolchain.onLibraryMigrationProgress((event) => {
      setLibraryMigrationProgress(event);
    });
  }, []);

  async function handleRevealArduinoLibraryFolder() {
    const currentInfo = libraryDirectoryInfo ?? (await refreshArduinoLibraryDirectory());
    if (!currentInfo) {
      return;
    }

    const result = await window.tantalum.shell.openPath(currentInfo.librariesDir);
    if (!result.success) {
      setLibraryDirectoryError(result.error);
    }
  }

  async function handleSelectArduinoStorageFolder() {
    setBusyAction('select-arduino-storage');
    setArduinoStorageMessage('');

    try {
      const result = await window.tantalum.toolchain.selectArduinoStorage();
      if (!result.success) {
        if (!result.canceled) {
          setLibraryDirectoryError(result.error);
        }
        return;
      }

      setArduinoStorageInfo(result);
      setArduinoStorageMessage('Arduino storage location updated. Restart any active installs before installing large packages.');
      await refreshArduinoLibraryDirectory();
    } finally {
      setBusyAction(null);
    }
  }

  async function handleClearArduinoStorageFolder() {
    if (!(await confirm({
      message: 'Use the default Arduino storage location again?',
      detail: 'Existing files on the other disk will not be deleted.',
      tone: 'warning',
      confirmLabel: 'Use default location',
    }))) {
      return;
    }

    setBusyAction('clear-arduino-storage');
    setArduinoStorageMessage('');

    try {
      const result = await window.tantalum.toolchain.clearArduinoStorage();
      if (!result.success) {
        setLibraryDirectoryError(result.error);
        return;
      }

      setArduinoStorageInfo(result);
      setArduinoStorageMessage('Arduino storage reset to the default location.');
      await refreshArduinoLibraryDirectory();
    } finally {
      setBusyAction(null);
    }
  }

  async function handleMigrateArduinoLibraries() {
    setBusyAction('migrate-libraries');
    setLibraryMigrationMessage('');
    setLibraryMigrationError('');
    setLibraryMigrationResult(null);
    setLibraryMigrationProgress(null);

    try {
      const currentInfo = libraryDirectoryInfo ?? (await refreshArduinoLibraryDirectory());
      const defaultPath = currentInfo?.configuredUserDir || currentInfo?.userDir;
      const selection = await window.tantalum.toolchain.selectLibrarySourceFolder({ defaultPath: defaultPath || undefined });

      if (!selection.success) {
        if (!selection.canceled) {
          setLibraryMigrationError(selection.error);
        }
        return;
      }

      const result = await window.tantalum.toolchain.migrateLibraries({ sourcePath: selection.path });
      if (result.success) {
        setLibraryMigrationResult(result);
        setLibraryMigrationMessage(
          `Migration complete: ${result.migrated.length} migrated, ${result.skipped.length} skipped, ${result.failed.length} failed.`
        );
        await refreshArduinoLibraryDirectory();
      } else {
        setLibraryMigrationError(result.error);
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteBoard() {
    if (!selectedBoard) {
      return;
    }

    if (!(await confirm({
      message: 'Delete board?',
      tone: 'danger',
      confirmLabel: 'Delete board',
    }))) {
      return;
    }

    setBusyAction('delete-board');
    try {
      await deleteBoard(selectedBoard.$id);
      await window.tantalum.secrets.deleteBoardSecrets(selectedBoard.$id);
      await refreshBoardsList();
    } catch (error) {
      console.error(error);
    } finally {
      setBusyAction(null);
    }
  }

  function renderBoardDetails() {
    if (!selectedBoard) {
      return (
        <div className="boards-hub-empty settings-boards-empty">
          <Cpu size={22} />
          <strong>Select a device</strong>
          <p>Choose a registered board from the list to view provisioning and firmware details.</p>
        </div>
      );
    }
    const liveStatus = calculateBoardStatus(selectedBoard.lastSeen, selectedBoard.status);

    return (
      <section className="settings-card settings-boards-detail-card">
        <div className="settings-boards-detail-header">
          <div>
            <h3>{selectedBoard.name}</h3>
            <p>{selectedBoard.boardType}</p>
          </div>
          <span className={`status-pill status-${liveStatus}`}>{liveStatus}</span>
        </div>
        <dl className="settings-boards-field-grid">
          <div>
            <dt>Provisioning</dt>
            <dd>{selectedBoard.provisioningStatus || 'pending'}</dd>
          </div>
          <div>
            <dt>Actual version</dt>
            <dd>{selectedBoard.firmwareVersion || '0.0.0'}</dd>
          </div>
          <div>
            <dt>Desired version</dt>
            <dd>{selectedBoard.desiredVersion || 'No deployment'}</dd>
          </div>
          <div>
            <dt>WiFi credentials</dt>
            <dd>Stored only on board</dd>
          </div>
        </dl>
        <div className="inline-banner">
          Your WiFi name and password are sent directly to the board. They are not uploaded to Tantalum Cloud and are not stored by the IDE.
        </div>
        <div className="settings-boards-detail-actions">
          <button className="boards-hub-btn boards-hub-btn-danger" type="button" onClick={() => void handleDeleteBoard()} disabled={busyAction === 'delete-board'}>
            Delete board
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-sidebar">
        <div className="settings-sidebar-header">
          <h2>Settings</h2>
        </div>
        <nav className="settings-nav">
          <button className={activeTab === 'appearance' ? 'active' : ''} onClick={() => onActiveTabChange('appearance')}>Appearance</button>
          <button className={activeTab === 'editor' ? 'active' : ''} onClick={() => onActiveTabChange('editor')}>Editor</button>
          <button className={activeTab === 'agent' ? 'active' : ''} onClick={() => onActiveTabChange('agent')}>Agent Configuration</button>
          <button className={activeTab === 'git' ? 'active' : ''} onClick={() => onActiveTabChange('git')}>Git Configuration</button>
          <button className={activeTab === 'arduino' ? 'active' : ''} onClick={() => onActiveTabChange('arduino')}>Arduino Storage</button>
          <button className={activeTab === 'boards' ? 'active' : ''} onClick={() => onActiveTabChange('boards')}>Device Management</button>
        </nav>
      </div>
      
      <div className="settings-content">
        <div className="settings-top-bar">
          <button className="boards-hub-btn" type="button" onClick={onBackToWorkspace}>
            <ChevronLeft size={14} />
            Back to app
          </button>
        </div>

        {activeTab === 'appearance' && (
          <div className="settings-pane appearance-pane">
            <div className="settings-pane-header settings-pane-hero">
              <div>
                <h1>Appearance</h1>
                <p className="settings-pane-subtitle">{appName} {version}</p>
              </div>
              <button className="boards-hub-btn" type="button" onClick={onResetPreferences}>
                <RotateCcw size={14} /> Reset
              </button>
            </div>

            <div className="appearance-grid">
              <section className="settings-card">
                <div className="settings-card-heading">
                  <Palette size={16} />
                  <div>
                    <h3>Theme</h3>
                    <p>Choose light, dark, or your system default.</p>
                  </div>
                </div>
                <div className="segmented-control settings-segmented">
                  {[
                    { value: 'system', label: 'System', icon: Monitor },
                    { value: 'dark', label: 'Dark', icon: Moon },
                    { value: 'light', label: 'Light', icon: Sun },
                  ].map((option) => {
                    const Icon = option.icon;
                    return (
                      <button
                        key={option.value}
                        className={preferences.theme === option.value ? 'active' : ''}
                        type="button"
                        onClick={() => updatePreferences({ theme: option.value as ThemePreference })}
                      >
                        <Icon size={14} />
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-heading">
                  <Type size={16} />
                  <div>
                    <h3>Font</h3>
                    <p style={{ fontFamily: preferences.fontFamily }}>
                      {FONT_FAMILY_OPTIONS.find((option) => option.value === preferences.fontFamily)?.label ?? preferences.fontFamily}
                    </p>
                  </div>
                </div>
                <div className="settings-form-grid">
                  <label>
                    Font family
                    <select value={preferences.fontFamily} onChange={(event) => updatePreferences({ fontFamily: event.target.value })}>
                      {FONT_FAMILY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Font size
                    <div className="range-field">
                      <input
                        type="range"
                        min="11"
                        max="18"
                        step="1"
                        value={preferences.fontSize}
                        onChange={(event) => updatePreferences({ fontSize: Number(event.target.value) })}
                      />
                      <input
                        type="number"
                        min="11"
                        max="18"
                        value={preferences.fontSize}
                        onChange={(event) => updatePreferences({ fontSize: Number(event.target.value) })}
                        aria-label="Font size"
                      />
                    </div>
                  </label>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-heading">
                  <Palette size={16} />
                  <div>
                    <h3>Accent color</h3>
                    <p>Pick a preset or choose any custom color.</p>
                  </div>
                </div>
                <div className="accent-picker">
                  <div className="accent-presets">
                    {ACCENT_PRESETS.map((color) => (
                      <button
                        key={color}
                        className={preferences.accentColor.toLowerCase() === color.toLowerCase() ? 'active' : ''}
                        type="button"
                        style={{ backgroundColor: color }}
                        onClick={() => updatePreferences({ accentColor: color })}
                        aria-label={`Use accent color ${color}`}
                      />
                    ))}
                  </div>
                  <label className="custom-color-field">
                    Custom
                    <input type="color" value={preferences.accentColor} onChange={(event) => updatePreferences({ accentColor: event.target.value })} />
                    <span>{preferences.accentColor}</span>
                  </label>
                </div>
              </section>
            </div>
          </div>
        )}

        {activeTab === 'editor' && (
          <div className="settings-pane editor-settings-pane">
            <div className="settings-pane-header settings-pane-hero">
              <div>
                <h1>Editor</h1>
                <p className="settings-pane-subtitle">Customize Monaco editing behavior and code intelligence.</p>
              </div>
              <button className="boards-hub-btn" type="button" onClick={onResetPreferences}>
                <RotateCcw size={14} /> Reset
              </button>
            </div>

            <div className="appearance-grid">
              <section className="settings-card">
                <div className="settings-card-heading">
                  <Type size={16} />
                  <div>
                    <h3>Text Editor</h3>
                    <p>Set the code font, size, tabs, wrapping, and line numbers.</p>
                  </div>
                </div>
                <div className="settings-form-grid">
                  <label>
                    Editor font family
                    <select value={preferences.editorFontFamily} onChange={(event) => updatePreferences({ editorFontFamily: event.target.value })}>
                      {FONT_FAMILY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Editor font size
                    <div className="range-field">
                      <input
                        type="range"
                        min="10"
                        max="24"
                        step="1"
                        value={preferences.editorFontSize}
                        onChange={(event) => updatePreferences({ editorFontSize: Number(event.target.value) })}
                      />
                      <input
                        type="number"
                        min="10"
                        max="24"
                        value={preferences.editorFontSize}
                        onChange={(event) => updatePreferences({ editorFontSize: Number(event.target.value) })}
                        aria-label="Editor font size"
                      />
                    </div>
                  </label>
                  <label>
                    Tab size
                    <select value={preferences.editorTabSize} onChange={(event) => updatePreferences({ editorTabSize: Number(event.target.value) })}>
                      {[2, 3, 4, 6, 8].map((size) => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Word wrap
                    <select value={preferences.editorWordWrap} onChange={(event) => updatePreferences({ editorWordWrap: event.target.value as UiPreferences['editorWordWrap'] })}>
                      <option value="off">Off</option>
                      <option value="on">On</option>
                    </select>
                  </label>
                  <label>
                    Line numbers
                    <select value={preferences.editorLineNumbers} onChange={(event) => updatePreferences({ editorLineNumbers: event.target.value as UiPreferences['editorLineNumbers'] })}>
                      <option value="on">On</option>
                      <option value="relative">Relative</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="settings-card settings-list-card">
                <div className="settings-card-heading">
                  <Code2 size={16} />
                  <div>
                    <h3>Editor Features</h3>
                    <p>Control suggestions, navigation aids, formatting, and visual helpers.</p>
                  </div>
                </div>
                <div className="settings-row-list">
                  {renderToggleSetting('editorQuickSuggestions', 'Quick Suggestions', 'Show suggestions as you type in code, comments, and strings.')}
                  {renderToggleSetting('editorInlineSuggest', 'Inline Suggestions', 'Preview ghost text suggestions inside the current line.')}
                  {renderToggleSetting('editorInlayHints', 'Inlay Hints', 'Show parameter names and inferred type hints when available.')}
                  {renderToggleSetting('editorCodeLens', 'Code Lens', 'Show contextual code actions above symbols where Monaco supports them.')}
                  {renderToggleSetting('editorMinimap', 'Minimap', 'Display the compact code map on the right edge of the editor.')}
                  {renderToggleSetting('editorStickyScroll', 'Sticky Scroll', 'Keep the current scope header visible while scrolling.')}
                  {renderToggleSetting('editorFormatOnType', 'Format On Type', 'Format supported syntax while you type.')}
                  {renderToggleSetting('editorFormatOnPaste', 'Format On Paste', 'Format supported syntax when pasting code.')}
                  {renderToggleSetting('editorBracketPairs', 'Bracket Pair Guides', 'Highlight matching brackets and show bracket pair guides.')}
                  {renderToggleSetting('editorAutoSave', 'Auto Save', 'Automatically save existing files shortly after edits.')}
                </div>
              </section>
            </div>
          </div>
        )}

        {activeTab === 'agent' && (
          <div className="settings-pane agent-settings-pane">
            <div className="settings-pane-header settings-pane-hero">
              <div>
                <h1>Agent Configuration</h1>
                <p className="settings-pane-subtitle">Configure AI models, API keys, tools, and usage.</p>
              </div>
            </div>
            <AgentPanel
              user={user}
              workspacePath={null}
              activeTab={null}
              pushConsole={() => {}}
              pushToast={pushToast}
              defaultView="settings"
              hideChat={true}
              settingsOnly={true}
            />
          </div>
        )}

        {activeTab === 'git' && (
          <div className="settings-pane git-settings-pane">
            <div className="settings-pane-header settings-pane-hero">
              <div>
                <h1>Git Configuration</h1>
                <p className="settings-pane-subtitle">Configure Git identity and publishing credentials for GitHub or GitLab.</p>
              </div>
              <button className="boards-hub-btn boards-hub-btn-primary" type="button" onClick={() => void handleSaveGitConfiguration()} disabled={busyAction === 'save-git-config'}>
                <Save size={14} /> Save
              </button>
            </div>

            {gitConfigError ? <div className="inline-banner inline-banner-error">{gitConfigError}</div> : null}
            {gitConfigMessage ? <div className="inline-banner inline-banner-success">{gitConfigMessage}</div> : null}

            <div className="appearance-grid">
              <section className="settings-card">
                <div className="settings-card-heading">
                  <GitBranch size={16} />
                  <div>
                    <h3>Identity</h3>
                    <p>Stored in your global Git config and used for commits.</p>
                  </div>
                </div>
                <div className="settings-form-grid">
                  <label>
                    Git user name
                    <input value={gitConfiguration.gitUserName} onChange={(event) => updateGitConfiguration({ gitUserName: event.target.value })} placeholder="Your Name" />
                  </label>
                  <label>
                    Git user email
                    <input value={gitConfiguration.gitUserEmail} onChange={(event) => updateGitConfiguration({ gitUserEmail: event.target.value })} placeholder="you@example.com" />
                  </label>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-heading">
                  <KeyRound size={16} />
                  <div>
                    <h3>Provider</h3>
                    <p>Used by Publish Repository when creating hosted remotes.</p>
                  </div>
                </div>
                <div className="settings-form-grid">
                  <label>
                    Default provider
                    <select value={gitConfiguration.defaultProvider} onChange={(event) => updateGitConfiguration({ defaultProvider: event.target.value as GitProvider })}>
                      <option value="github">GitHub</option>
                      <option value="gitlab">GitLab</option>
                    </select>
                  </label>
                  <label>
                    GitHub username
                    <input value={gitConfiguration.githubUsername} onChange={(event) => updateGitConfiguration({ githubUsername: event.target.value })} placeholder="github-user" />
                  </label>
                  <label>
                    GitLab username
                    <input value={gitConfiguration.gitlabUsername} onChange={(event) => updateGitConfiguration({ gitlabUsername: event.target.value })} placeholder="gitlab-user" />
                  </label>
                </div>
              </section>

              <section className="settings-card settings-list-card git-token-card">
                <div className="settings-card-heading">
                  <KeyRound size={16} />
                  <div>
                    <h3>Tokens</h3>
                    <p>Tokens stay in the local desktop secret store and are used only for creating and publishing remotes.</p>
                  </div>
                </div>
                <div className="settings-form-grid">
                  <label>
                    GitHub token
                    <input
                      type="password"
                      value={gitTokenInputs.githubToken}
                      onChange={(event) => setGitTokenInputs((current) => ({ ...current, githubToken: event.target.value }))}
                      placeholder={gitConfiguration.githubTokenConfigured ? 'Configured' : 'ghp_...'}
                    />
                  </label>
                  <label>
                    GitLab token
                    <input
                      type="password"
                      value={gitTokenInputs.gitlabToken}
                      onChange={(event) => setGitTokenInputs((current) => ({ ...current, gitlabToken: event.target.value }))}
                      placeholder={gitConfiguration.gitlabTokenConfigured ? 'Configured' : 'glpat-...'}
                    />
                  </label>
                </div>
                <div className="git-token-actions">
                  <span>{gitConfiguration.githubTokenConfigured ? 'GitHub token configured' : 'No GitHub token'}</span>
                  <button className="boards-hub-btn" type="button" onClick={() => void handleSaveGitConfiguration({ clearGithubToken: true })} disabled={!gitConfiguration.githubTokenConfigured || busyAction === 'save-git-config'}>
                    Clear GitHub token
                  </button>
                  <span>{gitConfiguration.gitlabTokenConfigured ? 'GitLab token configured' : 'No GitLab token'}</span>
                  <button className="boards-hub-btn" type="button" onClick={() => void handleSaveGitConfiguration({ clearGitlabToken: true })} disabled={!gitConfiguration.gitlabTokenConfigured || busyAction === 'save-git-config'}>
                    Clear GitLab token
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}

        {activeTab === 'arduino' && (
          <div className="settings-pane arduino-settings-pane">
            <div className="settings-pane-header settings-pane-hero">
              <div>
                <h1>Arduino Storage</h1>
                <p className="settings-pane-subtitle">Move board cores, package downloads, temp extraction, build cache, and libraries off the system disk.</p>
              </div>
            </div>

            {libraryDirectoryError ? <div className="inline-banner inline-banner-error">{libraryDirectoryError}</div> : null}
            {arduinoStorageMessage ? <div className="inline-banner inline-banner-success">{arduinoStorageMessage}</div> : null}

            <div className="appearance-grid">
              <section className="settings-card settings-list-card">
                <div className="settings-card-heading">
                  <AlertTriangle size={16} />
                  <div>
                    <h3>Upload safety</h3>
                    <p>Control whether USB and OTA uploads verify the sketch before upload work starts.</p>
                  </div>
                </div>
                <div className="settings-row-list">
                  {renderToggleSetting('verifyBeforeUpload', 'Verify before upload', 'Compile and check the sketch before USB or OTA upload starts.')}
                  {renderToggleSetting('sourceSnapshotsEnabled', 'Save source snapshots', 'Save compiled source during uploads so View code can restore exact files later.')}
                </div>
                {!preferences.verifyBeforeUpload ? (
                  <div className="inline-banner inline-banner-warning arduino-inline-banner">
                    Direct uploads skip the separate Verify step. Bad firmware or incorrect board settings can crash, lock up, or misconfigure attached hardware. Use at your own risk.
                  </div>
                ) : null}
                {!preferences.sourceSnapshotsEnabled ? (
                  <div className="inline-banner inline-banner-warning arduino-inline-banner">
                    View Code will only restore snapshots saved before this setting was turned off.
                  </div>
                ) : null}
              </section>

              <section className="settings-card">
                <div className="settings-card-heading">
                  <FolderInput size={16} />
                  <div>
                    <h3>Toolchain storage root</h3>
                    <p>Use a folder on another drive for Arduino15 data, downloads, temporary files, build cache, and the sketchbook.</p>
                  </div>
                </div>
                <div className="arduino-library-path-card">
                  <span>Storage root</span>
                  <code>{arduinoStorageInfo?.configured ? arduinoStorageInfo.storageRoot : 'Default Arduino CLI location'}</code>
                </div>
                {arduinoStorageInfo?.configured ? (
                  <div className="arduino-migration-summary">
                    <div>
                      <span>Package data</span>
                      <code>{arduinoStorageInfo.dataDir}</code>
                    </div>
                    <div>
                      <span>Downloads</span>
                      <code>{arduinoStorageInfo.downloadsDir}</code>
                    </div>
                    <div>
                      <span>Temp</span>
                      <code>{arduinoStorageInfo.tempDir}</code>
                    </div>
                    <div>
                      <span>Build cache</span>
                      <code>{arduinoStorageInfo.buildCacheDir}</code>
                    </div>
                  </div>
                ) : null}
                <div className="settings-action-row">
                  <button className="boards-hub-btn boards-hub-btn-primary" type="button" onClick={() => void handleSelectArduinoStorageFolder()} disabled={busyAction === 'select-arduino-storage'}>
                    <FolderOpen size={14} /> {busyAction === 'select-arduino-storage' ? 'Choosing...' : 'Choose folder'}
                  </button>
                  <button className="boards-hub-btn" type="button" onClick={() => void refreshArduinoStorage()}>
                    Refresh
                  </button>
                  <button className="boards-hub-btn" type="button" onClick={() => void handleClearArduinoStorageFolder()} disabled={!arduinoStorageInfo?.configured || busyAction === 'clear-arduino-storage'}>
                    Use default
                  </button>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-heading">
                  <FolderOpen size={16} />
                  <div>
                    <h3>Active library folder</h3>
                    <p>Tantalum installs and compiles libraries from this writable folder.</p>
                  </div>
                </div>
                <div className="arduino-library-path-card">
                  <span>Libraries folder</span>
                  <code>{libraryDirectoryInfo?.librariesDir || 'Loading...'}</code>
                </div>
                {libraryDirectoryInfo?.fallback ? (
                  <div className="inline-banner inline-banner-warning arduino-inline-banner">
                    Tantalum is using its app-managed Arduino folder because the Arduino CLI sketchbook folder was not writable.
                  </div>
                ) : null}
                <div className="settings-action-row">
                  <button className="boards-hub-btn" type="button" onClick={() => void refreshArduinoLibraryDirectory()}>
                    Refresh
                  </button>
                  <button className="boards-hub-btn" type="button" onClick={() => void handleRevealArduinoLibraryFolder()} disabled={!libraryDirectoryInfo}>
                    <FolderOpen size={14} /> Reveal folder
                  </button>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-heading">
                  <FolderInput size={16} />
                  <div>
                    <h3>Migrate from another Arduino IDE</h3>
                    <p>Choose the official Arduino sketchbook or its libraries folder and copy its libraries into Tantalum.</p>
                  </div>
                </div>

                <div className="settings-action-row">
                  <button className="boards-hub-btn boards-hub-btn-primary" type="button" onClick={() => void handleMigrateArduinoLibraries()} disabled={busyAction === 'migrate-libraries'}>
                    <Download size={14} /> {busyAction === 'migrate-libraries' ? 'Migrating...' : 'Migrate libraries'}
                  </button>
                </div>

                {libraryMigrationProgress ? (
                  <div className="arduino-migration-progress">
                    <div>
                      <strong>{libraryMigrationProgress.phase}</strong>
                      <span>{libraryMigrationProgress.message}</span>
                    </div>
                    <div className="arduino-progress-track" aria-label="Library migration progress">
                      <span style={{ width: `${Math.max(0, Math.min(100, libraryMigrationProgress.progress ?? 0))}%` }} />
                    </div>
                  </div>
                ) : null}

                {libraryMigrationError ? <div className="inline-banner inline-banner-error arduino-inline-banner">{libraryMigrationError}</div> : null}
                {libraryMigrationMessage ? <div className="inline-banner inline-banner-success arduino-inline-banner">{libraryMigrationMessage}</div> : null}

                {libraryMigrationResult ? (
                  <div className="arduino-migration-summary">
                    <div>
                      <span>Source</span>
                      <code>{libraryMigrationResult.sourceLibrariesDir}</code>
                    </div>
                    <div>
                      <span>Target</span>
                      <code>{libraryMigrationResult.targetLibrariesDir}</code>
                    </div>
                    {libraryMigrationResult.failed.slice(0, 3).map((entry) => (
                      <div key={`${entry.sourcePath}-${entry.name}`}>
                        <span>{entry.name}</span>
                        <small>{entry.reason}</small>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          </div>
        )}

        {activeTab === 'boards' && (
          <div className="settings-pane settings-boards-pane">
            <div className="settings-pane-header settings-pane-hero">
              <div>
                <h1>Devices</h1>
                <p className="settings-pane-subtitle">Manage your cloud boards and hardware devices.</p>
              </div>
              <button className="boards-hub-btn" type="button" onClick={() => void refreshBoardsList()} disabled={boardsLoading} title="Refresh cloud boards">
                {boardsLoading ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}
                Refresh
              </button>
            </div>

            <div className="inline-banner settings-boards-callout">
              Register new ESP devices from <strong>My Boards</strong> in the workspace. Connect a local board, then choose Enable Tantalum Cloud from the board card.
            </div>

            {boardsError ? <div className="inline-banner inline-banner-error">{boardsError}</div> : null}

            {boards.length === 0 && !boardsLoading ? (
              <div className="settings-boards-empty-panel boards-hub-empty">
                <Cpu size={22} />
                <strong>No cloud devices yet</strong>
                <p>Register devices from My Boards in the workspace.</p>
              </div>
            ) : (
              <div className="settings-boards-layout">
                <div className="settings-boards-list-panel">
                  <div className="settings-boards-list">
                    {boardsLoading && boards.length === 0 ? (
                      <div className="settings-boards-loading">
                        <LoaderCircle size={16} className="spin" />
                        <span>Loading cloud devices...</span>
                      </div>
                    ) : null}
                    {boards.map((board) => {
                      const status = calculateBoardStatus(board.lastSeen, board.status);
                      const isSelected = selectedBoardId === board.$id;
                      return (
                        <article key={board.$id} className={`boards-hub-card ${isSelected ? 'selected' : ''}`}>
                          <button
                            className="boards-hub-card-trigger"
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => setSelectedBoardId(board.$id)}
                          >
                            <span className="boards-hub-card-icon">
                              <Cpu size={18} strokeWidth={1.75} />
                              <span className={`boards-hub-status-dot status-${status}`} aria-hidden="true" />
                            </span>
                            <span className="boards-hub-card-text">
                              <strong>{board.name}</strong>
                              <span>{board.boardType}</span>
                            </span>
                            <ChevronRight size={16} className="boards-hub-card-chevron" aria-hidden="true" />
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </div>
                <div className="settings-boards-detail-panel">
                  <div className="settings-boards-detail">
                    {renderBoardDetails()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="toast-stack settings-toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <div className="toast-content">
              <span className="toast-message">{toast.message}</span>
            </div>
            <button className="toast-close-button" type="button" onClick={() => dismissToast(toast.id)} aria-label="Close notification">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
