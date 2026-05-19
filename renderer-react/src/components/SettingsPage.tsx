import { useEffect, useState } from 'react';
import type { Models } from 'appwrite';
import { Code2, Cpu, Monitor, Moon, Palette, Plus, RotateCcw, Sun, Type } from 'lucide-react';

import { createBoard, deleteBoard, listBoards } from '@/lib/boards';
import { hasRequiredCloudConfiguration } from '@/lib/config';
// no firmware
import type { BoardDocument, BoardInput } from '@/lib/models';
import { ACCENT_PRESETS, FONT_FAMILY_OPTIONS, type ThemePreference, type UiPreferences } from '@/lib/uiPreferences';
import { calculateBoardStatus } from '@/lib/utils';

import { AgentPanel } from './AgentPanel';
import { Modal } from './Modal';

type SettingsPageProps = {
  appName: string;
  version: string;
  user: Models.User<Models.Preferences>;
  preferences: UiPreferences;
  onPreferencesChange: (preferences: UiPreferences) => void;
  onResetPreferences: () => void;
};

const BOARD_OPTIONS = [
  { value: 'esp32:esp32:esp32', label: 'ESP32 DevKit' },
  { value: 'esp32:esp32:esp32s2', label: 'ESP32-S2' },
  { value: 'esp32:esp32:esp32s3', label: 'ESP32-S3' },
  { value: 'esp32:esp32:esp32c3', label: 'ESP32-C3' },
  { value: 'esp8266:esp8266:generic', label: 'ESP8266 Generic' },
  { value: 'arduino:avr:uno', label: 'Arduino Uno' },
];

export function SettingsPage({ appName, version, user, preferences, onPreferencesChange, onResetPreferences }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<'appearance' | 'editor' | 'agent' | 'boards'>('appearance');
  
  const [boards, setBoards] = useState<BoardDocument[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [boardModalOpen, setBoardModalOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [boardForm, setBoardForm] = useState<BoardInput>({
    name: '',
    boardType: 'esp32:esp32:esp32',
    wifiSSID: '',
    wifiPassword: '',
  });

  const selectedBoard = boards.find((board) => board.$id === selectedBoardId) ?? null;

  function updatePreferences(nextPreferences: Partial<UiPreferences>) {
    onPreferencesChange({ ...preferences, ...nextPreferences });
  }

  function renderToggleSetting(key: keyof UiPreferences, title: string, description: string) {
    const checked = Boolean(preferences[key]);

    return (
      <label className="settings-row">
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => updatePreferences({ [key]: event.target.checked } as Partial<UiPreferences>)}
        />
      </label>
    );
  }

  async function refreshBoardsList() {
    if (!hasRequiredCloudConfiguration()) {
      return;
    }
    try {
      const nextBoards = await listBoards();
      setBoards(nextBoards);
      if (!selectedBoardId && nextBoards.length > 0) {
        setSelectedBoardId(nextBoards[0].$id);
      }
      if (selectedBoardId && !nextBoards.some((board) => board.$id === selectedBoardId)) {
        setSelectedBoardId(nextBoards[0]?.$id ?? '');
      }
    } catch (error) {
      console.error(error);
    }
  }

  useEffect(() => {
    void refreshBoardsList();
  }, []);

  useEffect(() => {
    // Left intentionally empty or we can just remove it
  }, [selectedBoardId]);

  async function handleCreateBoard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction('create-board');
    try {
      const result = await createBoard(boardForm, user);
      const doc = result.board;
      if (boardForm.wifiSSID || boardForm.wifiPassword) {
        await window.tantalum.secrets.setBoardSecrets({
          boardId: doc.$id,
          apiToken: result.apiToken || doc.tokenPreview || '',
          wifiPassword: boardForm.wifiPassword,
        });
      }
      setBoardModalOpen(false);
      setBoardForm({ name: '', boardType: 'esp32:esp32:esp32', wifiSSID: '', wifiPassword: '' });
      await refreshBoardsList();
    } catch (error) {
      console.error(error);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteBoard() {
    if (!selectedBoard || !confirm('Delete board?')) return;
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
        <div className="empty-panel">
          <Cpu size={22} />
          <p>Select a board to view details.</p>
        </div>
      );
    }
    const liveStatus = calculateBoardStatus(selectedBoard.lastSeen, selectedBoard.status);

    return (
      <div className="detail-stack">
        <section className="detail-card">
          <div className="detail-head">
            <div>
              <h3>{selectedBoard.name}</h3>
              <p>{selectedBoard.boardType}</p>
            </div>
            <span className={`status-pill status-${liveStatus}`}>{liveStatus}</span>
          </div>
          <dl className="detail-grid">
            <div>
              <dt>WiFi network</dt>
              <dd>{selectedBoard.wifiSSID}</dd>
            </div>
            <div>
              <dt>Current version</dt>
              <dd>{selectedBoard.firmwareVersion || '1.0.0'}</dd>
            </div>
          </dl>
          <div className="action-row">
            <button className="danger-button" type="button" onClick={() => void handleDeleteBoard()} disabled={busyAction === 'delete-board'}>
              Delete board
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-sidebar">
        <div className="settings-sidebar-header">
          <h2>Settings</h2>
        </div>
        <nav className="settings-nav">
          <button className={activeTab === 'appearance' ? 'active' : ''} onClick={() => setActiveTab('appearance')}>Appearance</button>
          <button className={activeTab === 'editor' ? 'active' : ''} onClick={() => setActiveTab('editor')}>Editor</button>
          <button className={activeTab === 'agent' ? 'active' : ''} onClick={() => setActiveTab('agent')}>Agent Configuration</button>
          <button className={activeTab === 'boards' ? 'active' : ''} onClick={() => setActiveTab('boards')}>Device Management</button>
        </nav>
      </div>
      
      <div className="settings-content">
        {activeTab === 'appearance' && (
          <div className="settings-pane appearance-pane">
            <div className="settings-pane-header">
              <div>
                <h2>Appearance</h2>
                <p className="text-muted">{appName} {version}</p>
              </div>
              <button className="secondary-button compact" type="button" onClick={onResetPreferences}>
                <RotateCcw size={15} /> Reset
              </button>
            </div>

            <div className="appearance-grid">
              <section className="settings-card">
                <div className="settings-card-heading">
                  <Palette size={18} />
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
                  <Type size={18} />
                  <div>
                    <h3>Font</h3>
                    <p>VS Code defaults are used across the interface.</p>
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
                  <Palette size={18} />
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
            <div className="settings-pane-header">
              <div>
                <h2>Editor</h2>
                <p className="text-muted">Customize Monaco editing behavior and code intelligence.</p>
              </div>
              <button className="secondary-button compact" type="button" onClick={onResetPreferences}>
                <RotateCcw size={15} /> Reset
              </button>
            </div>

            <div className="settings-search-box">
              <Code2 size={16} />
              <span>Editor settings</span>
            </div>

            <div className="appearance-grid">
              <section className="settings-card">
                <div className="settings-card-heading">
                  <Type size={18} />
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
                  <Code2 size={18} />
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
                </div>
              </section>
            </div>
          </div>
        )}

        {activeTab === 'agent' && (
          <div className="settings-pane">
            <AgentPanel 
              user={user} 
              workspacePath={null} 
              activeTab={null} 
              onFileContentApplied={() => {}} 
              onPathDeleted={() => {}} 
              onRefreshWorkspace={() => {}} 
              pushConsole={() => {}} 
              pushToast={() => {}} 
              defaultView="settings" 
              hideChat={true} 
            />
          </div>
        )}

        {activeTab === 'boards' && (
          <div className="settings-pane boards-pane">
            <div className="settings-pane-header">
              <div>
                <h2>Devices</h2>
                <p className="text-muted">Manage your cloud boards and hardware devices.</p>
              </div>
              <button className="primary-button compact" type="button" onClick={() => setBoardModalOpen(true)}>
                <Plus size={16} /> Add board
              </button>
            </div>
            <div className="boards-split-view">
              <div className="board-list">
                {boards.map((board) => {
                  const status = calculateBoardStatus(board.lastSeen, board.status);
                  return (
                    <button
                      key={board.$id}
                      className={`board-card ${selectedBoardId === board.$id ? 'active' : ''}`}
                      type="button"
                      onClick={() => setSelectedBoardId(board.$id)}
                    >
                      <div className="board-card-head">
                        <strong>{board.name}</strong>
                        <span className={`status-pill status-${status}`}>{status}</span>
                      </div>
                      <p>{board.boardType}</p>
                    </button>
                  );
                })}
              </div>
              <div className="board-details-container">
                {renderBoardDetails()}
              </div>
            </div>
          </div>
        )}
      </div>

      <Modal open={boardModalOpen} title="Add board" subtitle="WiFi secrets stay local to this computer." onClose={() => setBoardModalOpen(false)}>
        <form className="modal-form" onSubmit={handleCreateBoard}>
          <label>
            Board name
            <input value={boardForm.name} onChange={(event) => setBoardForm((current) => ({ ...current, name: event.target.value }))} placeholder="Living room ESP32" />
          </label>
          <label>
            Board type
            <select value={boardForm.boardType} onChange={(event) => setBoardForm((current) => ({ ...current, boardType: event.target.value }))}>
              {BOARD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            WiFi SSID
            <input value={boardForm.wifiSSID} onChange={(event) => setBoardForm((current) => ({ ...current, wifiSSID: event.target.value }))} placeholder="Office WiFi" />
          </label>
          <label>
            WiFi password
            <input type="password" value={boardForm.wifiPassword} onChange={(event) => setBoardForm((current) => ({ ...current, wifiPassword: event.target.value }))} placeholder="••••••••" />
          </label>
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={() => setBoardModalOpen(false)}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={busyAction === 'create-board'}>
              {busyAction === 'create-board' ? 'Creating...' : 'Create board'}
            </button>
          </div>
        </form>
      </Modal>

    </div>
  );
}
