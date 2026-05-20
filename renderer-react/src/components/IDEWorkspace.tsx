import '@knurdz/jack-file-tree/keyboard-shield';

import { startTransition, useCallback, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Models } from 'appwrite';
import {
  EditorTabs,
  closeEditorTab,
  openEditorTab,
  reorderEditorTabs,
  type EditorTabItem,
} from '@knurdz/jack-editor-tab';
import {
  FileTree,
  type FileTreeContextMenuActionId,
  type FileTreeContextMenuRenderProps,
  type FileTreeFsAdapter,
  type FileTreeHeaderActionRenderProps,
  type FileTreeHeaderRenderProps,
  type FileTreeItemType,
  type FileTreeNode,
  type FileTreeTheme,
} from '@knurdz/jack-file-tree';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import {
  BookmarkCheck,
  BookmarkPlus,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  Cpu,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  HardDriveUpload,
  LayoutGrid,
  LayoutList,
  Library,
  ListChevronsDownUp,
  ListChevronsUpDown,
  LoaderCircle,
  MoreHorizontal,
  PencilLine,
  Plus,
  RefreshCcw,
  Search,
  Scissors,
  Star,
  TerminalSquare,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { editor } from 'monaco-editor';

import { createBoard, deleteBoard, listBoards, rotateBoardToken, updateBoard } from '@/lib/boards';
import { appwriteConfig, hasBoardAdminFunction, hasDeviceGatewayFunction, hasRequiredCloudConfiguration } from '@/lib/config';
import {
  configureArduinoCppLanguageSupport,
  updateArduinoCppDiagnostics,
} from '@/lib/cppLanguageSupport';
import { deleteFirmwareRelease, listFirmwareHistory, markFirmwareAsCurrent, uploadFirmwareRelease } from '@/lib/firmware';
import type { BoardDocument, BoardInput, BoardSecret, FirmwareDocument } from '@/lib/models';
import type { UiPreferences } from '@/lib/uiPreferences';
import {
  calculateBoardStatus,
  fileNameFromPath,
  formatBytes,
  isFirmwareFileName,
  joinPath,
  nextSemver,
  normalizeOutput,
  parentPath,
  sha256Hex,
} from '@/lib/utils';
import type { GitStatus, MenuAction, ProjectFolder, WorkspaceReplaceChangedFile, WorkspaceSearchResult } from '@/types/electron';

import { ConsoleTerminal } from './ConsoleTerminal';
import { AgentPanel } from './AgentPanel';
import { GitHistoryPanel, GitSourceControlPanel, GitWorkspace } from './GitWorkspace';
import { useGitWorkspaceController } from './useGitWorkspaceController';
import { Modal } from './Modal';
import { TerminalWorkspace } from './TerminalWorkspace';
import { WorkspaceSearchPopup } from './WorkspaceSearchPopup';

type IDEWorkspaceProps = {
  active?: boolean;
  appName: string;
  version: string;
  platform: string;
  user: Models.User<Models.Preferences>;
  onSignedOut: () => void;
  onOpenSettings?: () => void;
  sidebar: SidebarView;
  onSidebarChange: (sidebar: SidebarView) => void;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  onBottomPanelOpenChange: (open: boolean) => void;
  onWorkspaceTitleChange?: (title: string) => void;
  workspaceSearchOpen: boolean;
  onWorkspaceSearchOpenChange: (open: boolean) => void;
  uiPreferences: UiPreferences;
  resolvedTheme: 'dark' | 'light';
};

export type SidebarView = 'explorer' | 'boards' | 'libraries' | 'git' | 'platforms' | 'terminal' | 'my-projects';
type ConsoleView = 'output' | 'terminal';
type FileTabState = 'temporary' | 'preview' | 'saved';
type ProjectSortMode = 'recent' | 'name' | 'favorites';
type ProjectViewMode = 'grid' | 'list';

type FileTab = EditorTabItem & {
  id: string;
  content: string;
  savedContent: string;
  fileState: FileTabState;
};

function getFileTabSavedContent(tab: FileTab) {
  return typeof tab.savedContent === 'string' ? tab.savedContent : tab.content;
}

function isTemporaryFileTab(tab: FileTab) {
  return tab.fileState === 'temporary' || tab.path.startsWith('untitled:');
}

function syncFileTabDirtyState(tab: FileTab): FileTab {
  const savedContent = getFileTabSavedContent(tab);
  const isDirty = isTemporaryFileTab(tab) || tab.content !== savedContent;

  if (tab.savedContent === savedContent && tab.isDirty === isDirty) {
    return tab;
  }

  return {
    ...tab,
    savedContent,
    isDirty,
  };
}

function normalizeFileTabPath(tabPath: string) {
  return tabPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isSameFileTabPath(leftPath: string, rightPath: string) {
  return normalizeFileTabPath(leftPath) === normalizeFileTabPath(rightPath);
}

type ConsoleEntry = {
  id: number;
  level: 'info' | 'success' | 'error';
  message: string;
};

type Toast = {
  id: number;
  tone: 'info' | 'success' | 'error';
  message: string;
};

type BoardPlatform = {
  id: string;
  name: string;
  latest?: string;
  version?: string;
  maintainer?: string;
  description?: string;
  website?: string;
  installed?: boolean;
};

type LibraryEntry = {
  name: string;
  version?: string;
  sentence?: string;
  paragraph?: string;
  author?: string;
  maintainer?: string;
  category?: string;
  installed?: boolean;
};

const DEFAULT_MANAGER_RESULT_LIMIT = 20;
const MANAGER_LOAD_TIMEOUT_MS = 8000;

const FALLBACK_LIBRARY_RESULTS: LibraryEntry[] = [
  { name: 'ArduinoJson', version: 'latest', sentence: 'JSON serialization and parsing for embedded projects.', author: 'Benoit Blanchon', category: 'Data Processing' },
  { name: 'Adafruit NeoPixel', version: 'latest', sentence: 'Control single-wire RGB and RGBW LED strips and pixels.', author: 'Adafruit', category: 'Display' },
  { name: 'DHT sensor library', version: 'latest', sentence: 'Read DHT11, DHT22, and compatible humidity and temperature sensors.', author: 'Adafruit', category: 'Sensors' },
  { name: 'Adafruit GFX Library', version: 'latest', sentence: 'Core graphics primitives for many Arduino displays.', author: 'Adafruit', category: 'Display' },
  { name: 'Adafruit SSD1306', version: 'latest', sentence: 'OLED display driver for SSD1306 monochrome displays.', author: 'Adafruit', category: 'Display' },
  { name: 'Adafruit BusIO', version: 'latest', sentence: 'I2C and SPI helper library used by many sensor drivers.', author: 'Adafruit', category: 'Communication' },
  { name: 'FastLED', version: 'latest', sentence: 'High-performance LED animation library for addressable strips.', author: 'FastLED', category: 'Display' },
  { name: 'PubSubClient', version: 'latest', sentence: 'Lightweight MQTT client for Arduino network projects.', author: 'Nick O Leary', category: 'Communication' },
  { name: 'OneWire', version: 'latest', sentence: 'Communicate with Dallas/Maxim 1-Wire devices.', author: 'Paul Stoffregen', category: 'Communication' },
  { name: 'DallasTemperature', version: 'latest', sentence: 'Temperature sensor helpers for Dallas 1-Wire devices.', author: 'Miles Burton', category: 'Sensors' },
  { name: 'AccelStepper', version: 'latest', sentence: 'Control multiple stepper motors with acceleration support.', author: 'Mike McCauley', category: 'Device Control' },
  { name: 'ArduinoHttpClient', version: 'latest', sentence: 'HTTP client library for Arduino network stacks.', author: 'Arduino', category: 'Communication' },
  { name: 'ArduinoMqttClient', version: 'latest', sentence: 'MQTT client library maintained by Arduino.', author: 'Arduino', category: 'Communication' },
  { name: 'NTPClient', version: 'latest', sentence: 'Retrieve time from NTP servers over UDP.', author: 'Fabrice Weinberg', category: 'Timing' },
  { name: 'IRremote', version: 'latest', sentence: 'Send and receive infrared remote control signals.', author: 'Armin Joachimsmeyer', category: 'Signal Input/Output' },
  { name: 'MFRC522', version: 'latest', sentence: 'RFID reader support for MFRC522 modules.', author: 'GithubCommunity', category: 'Communication' },
  { name: 'RTClib', version: 'latest', sentence: 'Real-time clock support for DS1307, DS3231, and more.', author: 'Adafruit', category: 'Timing' },
  { name: 'Adafruit BMP280 Library', version: 'latest', sentence: 'Driver for BMP280 barometric pressure sensors.', author: 'Adafruit', category: 'Sensors' },
  { name: 'Adafruit BME280 Library', version: 'latest', sentence: 'Driver for BME280 humidity, pressure, and temperature sensors.', author: 'Adafruit', category: 'Sensors' },
  { name: 'ESP32Servo', version: 'latest', sentence: 'Servo control support for ESP32 boards.', author: 'Kevin Harrington', category: 'Device Control' },
];

const FALLBACK_PLATFORM_RESULTS: BoardPlatform[] = [
  { id: 'arduino:avr', name: 'Arduino AVR Boards', description: 'Official support for Uno, Nano, Mega, and classic AVR boards.', maintainer: 'Arduino' },
  { id: 'arduino:samd', name: 'Arduino SAMD Boards', description: 'Official support for MKR, Zero, and SAMD-based boards.', maintainer: 'Arduino' },
  { id: 'arduino:megaavr', name: 'Arduino megaAVR Boards', description: 'Official support for Nano Every and Uno WiFi Rev2 boards.', maintainer: 'Arduino' },
  { id: 'arduino:mbed_nano', name: 'Arduino Mbed OS Nano Boards', description: 'Mbed-based support for Nano 33 BLE class boards.', maintainer: 'Arduino' },
  { id: 'arduino:mbed_portenta', name: 'Arduino Mbed OS Portenta Boards', description: 'Mbed-based support for Portenta boards.', maintainer: 'Arduino' },
  { id: 'arduino:renesas_uno', name: 'Arduino UNO R4 Boards', description: 'Official support for Renesas-based UNO R4 boards.', maintainer: 'Arduino' },
  { id: 'arduino:renesas_portenta', name: 'Arduino Renesas Portenta Boards', description: 'Official support for Renesas Portenta boards.', maintainer: 'Arduino' },
  { id: 'arduino:esp32', name: 'Arduino ESP32 Boards', description: 'Arduino-maintained ESP32 board support.', maintainer: 'Arduino' },
  { id: 'esp32:esp32', name: 'esp32 by Espressif Systems', description: 'Espressif ESP32, ESP32-S2, ESP32-S3, and ESP32-C series support.', maintainer: 'Espressif Systems' },
  { id: 'esp8266:esp8266', name: 'ESP8266 Boards', description: 'Community ESP8266 core for Arduino.', maintainer: 'ESP8266 Community' },
  { id: 'rp2040:rp2040', name: 'Raspberry Pi Pico/RP2040', description: 'RP2040 board support for Pico and compatible boards.', maintainer: 'Earle F. Philhower' },
  { id: 'adafruit:samd', name: 'Adafruit SAMD Boards', description: 'Adafruit Feather, Metro, Trinket, and Circuit Playground SAMD boards.', maintainer: 'Adafruit' },
  { id: 'Seeeduino:samd', name: 'Seeed SAMD Boards', description: 'Seeeduino XIAO and other Seeed SAMD boards.', maintainer: 'Seeed Studio' },
  { id: 'STMicroelectronics:stm32', name: 'STM32 MCU Based Boards', description: 'STM32 board support from STMicroelectronics.', maintainer: 'STMicroelectronics' },
  { id: 'teensy:avr', name: 'Teensy Boards', description: 'PJRC Teensy board support for Arduino.', maintainer: 'PJRC' },
  { id: 'SparkFun:apollo3', name: 'SparkFun Apollo3 Boards', description: 'SparkFun Artemis and Apollo3 board support.', maintainer: 'SparkFun' },
  { id: 'sandeepmistry:nRF5', name: 'Nordic Semiconductor nRF5 Boards', description: 'nRF51 and nRF52 board support.', maintainer: 'Sandeep Mistry' },
  { id: 'MiniCore:avr', name: 'MiniCore AVR Boards', description: 'ATmega8/48/88/168/328 and related AVR board support.', maintainer: 'MCUdude' },
  { id: 'MegaCore:avr', name: 'MegaCore AVR Boards', description: 'ATmega64/128/640/1280/2560 and related AVR support.', maintainer: 'MCUdude' },
  { id: 'megaTinyCore:megaavr', name: 'megaTinyCore Boards', description: 'ATtiny tinyAVR 0/1/2-series board support.', maintainer: 'Spence Konde' },
];

function limitManagerResults<T>(entries: T[]) {
  return entries.slice(0, DEFAULT_MANAGER_RESULT_LIMIT);
}

function withManagerTimeout<T>(promise: Promise<T>, timeoutMs = MANAGER_LOAD_TIMEOUT_MS) {
  return new Promise<T | null>((resolve) => {
    const timeoutId = window.setTimeout(() => resolve(null), timeoutMs);

    promise.then(
      (result) => {
        window.clearTimeout(timeoutId);
        resolve(result);
      },
      () => {
        window.clearTimeout(timeoutId);
        resolve(null);
      },
    );
  });
}

function normalizePackageKey(value: string) {
  return value.trim().toLowerCase();
}

function applyLibraryInstalledState(libraries: LibraryEntry[], installedLibraries: LibraryEntry[]) {
  const installedNames = new Set(installedLibraries.map((entry) => normalizePackageKey(entry.name)));
  return libraries.map((library) => ({
    ...library,
    installed: installedNames.has(normalizePackageKey(library.name)),
  }));
}

function applyPlatformInstalledState(platforms: BoardPlatform[], installedPlatforms: BoardPlatform[]) {
  const installedIds = new Set(installedPlatforms.map((entry) => normalizePackageKey(entry.id)));
  return platforms.map((platform) => ({
    ...platform,
    installed: installedIds.has(normalizePackageKey(platform.id)),
  }));
}

type ResizablePanel = 'left' | 'right' | 'bottom';

type PanelSizes = Record<ResizablePanel, number>;

type ResizeSession = {
  panel: ResizablePanel;
  pointerId: number;
  startX: number;
  startY: number;
  startSize: number;
};

const DEFAULT_PANEL_SIZES: PanelSizes = {
  left: 280,
  right: 300,
  bottom: 260,
};

const MIN_PANEL_SIZES: PanelSizes = {
  left: 220,
  right: 240,
  bottom: 160,
};

const SIDE_PANEL_RESIZER_SIZE = 2;
const ACTIVITY_RAIL_WIDTH = 50;
const MIN_EDITOR_WIDTH = 360;
const MAX_SIDE_PANEL_WIDTH = 520;
const MAX_CONSOLE_HEIGHT = 520;
const PANEL_RESIZE_STEP = 16;
const AUTO_SAVE_DELAY_MS = 1000;
const RIGHT_PANEL_HIDDEN_BREAKPOINT = 1080;
const LEFT_PANEL_HIDDEN_BREAKPOINT = 980;
const EDITOR_PANEL_BACKGROUND = {
  dark: '#171717',
  light: '#f3f3f3',
} as const;

const BOARD_OPTIONS = [
  { value: 'esp32:esp32:esp32', label: 'ESP32 DevKit' },
  { value: 'esp32:esp32:esp32s2', label: 'ESP32-S2' },
  { value: 'esp32:esp32:esp32s3', label: 'ESP32-S3' },
  { value: 'esp32:esp32:esp32c3', label: 'ESP32-C3' },
  { value: 'esp8266:esp8266:generic', label: 'ESP8266 Generic' },
  { value: 'arduino:avr:uno', label: 'Arduino Uno' },
];

const DEFAULT_TAB_CONTENT = `// Start writing firmware in ${new Date().getFullYear()}

void setup() {
  // Put your setup code here.
}

void loop() {
  // Put your main code here.
}
`;

const FILE_TREE_INTERNAL_TRASH_DIR = '.tantalum-file-tree-trash';

const FILE_TREE_THEME: FileTreeTheme = {
  backgroundPrimary: 'var(--chrome-panel-bg)',
  backgroundSecondary: 'var(--chrome-panel-bg)',
  backgroundHover: 'rgba(108, 166, 255, 0.08)',
  textPrimary: '#f3f7fb',
  textSecondary: '#9baaba',
  textMuted: '#637384',
  accent: '#6ca6ff',
  accentTransparent: 'rgba(108, 166, 255, 0.16)',
  danger: '#ff7b72',
  menuBackground: 'var(--chrome-panel-bg)',
  menuBorder: 'rgba(255, 255, 255, 0.08)',
  menuHover: 'rgba(108, 166, 255, 0.12)',
  menuText: '#edf3f9',
  sidebarBorder: 'transparent',
  openFolderButtonBackground: 'transparent',
  openFolderButtonBackgroundHover: 'transparent',
  openFolderButtonText: 'rgba(255, 255, 255, 0.88)',
  openFolderButtonBorder: 'rgba(255, 255, 255, 0.42)',
  fontFamily: 'var(--system-font-family)',
};

const FILE_TREE_CONTEXT_MENU_ICONS: Record<FileTreeContextMenuActionId, LucideIcon> = {
  'new-file': FilePlus2,
  'new-folder': FolderPlus,
  'open-in-file-manager': FolderOpen,
  cut: Scissors,
  copy: Copy,
  paste: Clipboard,
  rename: PencilLine,
  delete: Trash2,
};

const FILE_TREE_HEADER_ACTION_ICONS: Record<Exclude<FileTreeHeaderActionRenderProps['id'], 'toggle-folders'>, LucideIcon> = {
  'new-file': FilePlus2,
  'new-folder': FolderPlus,
};

type FileTreeMoreAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  active?: boolean;
  disabled?: boolean;
};

function getFileTreeHeaderActionIcon(action: FileTreeHeaderActionRenderProps) {
  if (action.id === 'toggle-folders') {
    return action.pressed ? ListChevronsDownUp : ListChevronsUpDown;
  }

  return FILE_TREE_HEADER_ACTION_ICONS[action.id];
}

function renderFileTreeHeaderActions(actions: FileTreeHeaderActionRenderProps[]) {
  return actions.map((action) => {
    const Icon = getFileTreeHeaderActionIcon(action);

    return (
      <button
        aria-label={action.label}
        aria-pressed={action.pressed}
        className={`${action.className} workspace-tree-action-btn`}
        key={action.id}
        onClick={(event) => {
          event.stopPropagation();
          action.onClick();
        }}
        title={action.title}
        type="button"
      >
        <Icon aria-hidden="true" size={14} strokeWidth={1.85} />
      </button>
    );
  });
}

function renderFileTreeMoreMenuItems(actions: FileTreeMoreAction[]) {
  return actions.map((action) => (
    <button
      className={`workspace-tree-more-menu-item ${action.active ? 'active' : ''}`.trim()}
      disabled={action.disabled}
      key={action.id}
      onClick={(event) => {
        event.stopPropagation();
        if (action.disabled) {
          return;
        }

        action.onSelect();
      }}
      role="menuitem"
      type="button"
    >
      <span className="workspace-tree-more-menu-icon">{action.icon}</span>
      <span>{action.label}</span>
    </button>
  ));
}

function renderFileTreeHeaderMoreAction(action: FileTreeHeaderActionRenderProps): FileTreeMoreAction {
  const Icon = getFileTreeHeaderActionIcon(action);

  return {
    id: action.id,
    label: action.label,
    icon: <Icon aria-hidden="true" size={13} strokeWidth={1.85} />,
    onSelect: action.onClick,
    active: action.pressed,
  };
}

function renderCompactFileTreeHeader(
  { actions, actionsClassName, actionsStyle, className, title, titleClassName, workspaceRoot }: FileTreeHeaderRenderProps,
  moreMenu?: ReactNode,
) {
  const primaryActions = actions.filter((action) => action.id === 'new-file' || action.id === 'new-folder');

  return (
    <div className={`${className} workspace-tree-header-compact`} title={workspaceRoot ?? title}>
      <span className={titleClassName}>{title}</span>
      <div className={`${actionsClassName} workspace-tree-header-actions`} style={actionsStyle}>
        {renderFileTreeHeaderActions(primaryActions)}
        {moreMenu}
      </div>
    </div>
  );
}

function renderFileTreeContextMenu({ groups, closeMenu }: FileTreeContextMenuRenderProps) {
  const visibleGroups = groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0);

  return (
    <div className="workspace-tree-context-menu sft-context-menu" role="menu" onContextMenu={(event) => event.preventDefault()}>
      {visibleGroups.map((group, groupIndex) => (
        <div className="workspace-tree-context-menu-group" role="none" key={group.map((action) => action.id).join('-')}>
          {groupIndex > 0 ? <div className="workspace-tree-context-menu-separator sft-context-menu-separator" role="separator" /> : null}
          {group.map((action) => {
            const Icon = FILE_TREE_CONTEXT_MENU_ICONS[action.id] ?? ExternalLink;

            return (
              <button
                className={`workspace-tree-context-menu-item sft-context-menu-item${action.danger ? ' sft-danger' : ''}${action.disabled ? ' sft-disabled' : ''}`}
                disabled={action.disabled}
                key={action.id}
                onClick={async (event) => {
                  event.stopPropagation();
                  if (action.disabled) {
                    return;
                  }

                  try {
                    await action.onSelect();
                  } finally {
                    closeMenu();
                  }
                }}
                role="menuitem"
                type="button"
              >
                <span className="workspace-tree-context-menu-label">
                  <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                  <span>{action.label}</span>
                </span>
                {action.shortcut ? <span className="workspace-tree-context-menu-shortcut">{action.shortcut}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

let untitledTabCounter = 0;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getPanelMaxSize(panel: ResizablePanel, sizes: PanelSizes) {
  if (typeof window === 'undefined') {
    return panel === 'bottom' ? MAX_CONSOLE_HEIGHT : MAX_SIDE_PANEL_WIDTH;
  }

  if (panel === 'bottom') {
    return Math.max(MIN_PANEL_SIZES.bottom, Math.min(MAX_CONSOLE_HEIGHT, Math.floor(window.innerHeight * 0.45)));
  }

  if (panel === 'left' && window.innerWidth <= LEFT_PANEL_HIDDEN_BREAKPOINT) {
    return MAX_SIDE_PANEL_WIDTH;
  }

  if (panel === 'right' && window.innerWidth <= RIGHT_PANEL_HIDDEN_BREAKPOINT) {
    return MAX_SIDE_PANEL_WIDTH;
  }

  const isRightPanelVisible = window.innerWidth > RIGHT_PANEL_HIDDEN_BREAKPOINT;
  const siblingWidth = panel === 'left' ? (isRightPanelVisible ? sizes.right : 0) : sizes.left;
  const visibleResizers = isRightPanelVisible ? 2 : 1;
  const availableWidth = window.innerWidth - ACTIVITY_RAIL_WIDTH - SIDE_PANEL_RESIZER_SIZE * visibleResizers - siblingWidth - MIN_EDITOR_WIDTH;
  return Math.max(MIN_PANEL_SIZES[panel], Math.min(MAX_SIDE_PANEL_WIDTH, availableWidth));
}

function normalizePanelSizes(sizes: PanelSizes): PanelSizes {
  const left = clamp(sizes.left, MIN_PANEL_SIZES.left, getPanelMaxSize('left', sizes));
  const right = clamp(sizes.right, MIN_PANEL_SIZES.right, getPanelMaxSize('right', { ...sizes, left }));
  const bottom = clamp(sizes.bottom, MIN_PANEL_SIZES.bottom, getPanelMaxSize('bottom', sizes));

  return { left, right, bottom };
}

function createUntitledTab(name = 'sketch.ino', content = DEFAULT_TAB_CONTENT): FileTab {
  untitledTabCounter += 1;
  const path = `untitled:${Date.now()}-${untitledTabCounter}`;

  return {
    id: path,
    path,
    name,
    content,
    savedContent: content,
    isDirty: true,
    type: 'file',
    fileState: 'temporary',
  };
}

function createSavedTab(path: string, content: string, options?: { isPreview?: boolean; title?: string }): FileTab {
  const isPreview = options?.isPreview ?? false;

  return {
    id: path,
    path,
    name: fileNameFromPath(path),
    content,
    savedContent: content,
    isDirty: false,
    isPreviewFile: isPreview,
    type: 'file',
    title: options?.title,
    fileState: isPreview ? 'preview' : 'saved',
  };
}

function getProjectDisplayName(project: ProjectFolder) {
  return project.displayName || project.name;
}

function normalizeProjectPath(projectPath: string) {
  return projectPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getProjectActivityTime(project: ProjectFolder) {
  return new Date(project.lastOpenedAt || project.addedAt).getTime() || 0;
}

function formatProjectDate(value?: string) {
  if (!value) {
    return 'Never';
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return 'Unknown';
  }
}

function getProjectFolderIconVariant(platform: string) {
  const normalizedPlatform = platform.toLowerCase();
  return normalizedPlatform.includes('darwin') || normalizedPlatform.includes('mac') ? 'mac' : 'windows';
}

function ProjectSystemFolderIcon({ missing, platform }: { missing?: boolean; platform: string }) {
  const variant = getProjectFolderIconVariant(platform);

  return (
    <span className={`project-system-folder project-system-folder-${variant} ${missing ? 'project-system-folder-missing' : ''}`} aria-hidden="true">
      <span className="project-system-folder-back" />
      <span className="project-system-folder-front">
        {variant === 'mac' ? <span className="project-system-folder-face" /> : <span className="project-system-folder-pane" />}
      </span>
    </span>
  );
}

function defineTantalumEditorThemes(monaco: Monaco, accentColor: string) {
  const accent = accentColor.replace('#', '');

  monaco.editor.defineTheme('tantalum-minimal-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a737d' },
      { token: 'keyword', foreground: '569cd6' },
      { token: 'string', foreground: 'ce9178' },
    ],
    colors: {
      'editor.background': EDITOR_PANEL_BACKGROUND.dark,
      'editor.foreground': '#d4d4d4',
      'editorGutter.background': EDITOR_PANEL_BACKGROUND.dark,
      'editorLineNumber.foreground': '#858585',
      'editorLineNumber.activeForeground': '#c6c6c6',
      'editorIndentGuide.background1': '#404040',
      'editor.selectionBackground': '#264f78',
      'editor.lineHighlightBackground': '#2a2d2e',
      'editorCursor.foreground': `#${accent}`,
      'editorWhitespace.foreground': '#3b3b3b',
      'editorStickyScroll.background': EDITOR_PANEL_BACKGROUND.dark,
      'minimap.background': EDITOR_PANEL_BACKGROUND.dark,
    },
  });

  monaco.editor.defineTheme('tantalum-minimal-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '008000' },
      { token: 'keyword', foreground: '0000ff' },
      { token: 'string', foreground: 'a31515' },
    ],
    colors: {
      'editor.background': EDITOR_PANEL_BACKGROUND.light,
      'editor.foreground': '#1f1f1f',
      'editorGutter.background': EDITOR_PANEL_BACKGROUND.light,
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#24292f',
      'editorIndentGuide.background1': '#d0d7de',
      'editor.selectionBackground': '#add6ff',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editorCursor.foreground': `#${accent}`,
      'editorWhitespace.foreground': '#d8dee4',
      'editorStickyScroll.background': EDITOR_PANEL_BACKGROUND.light,
      'minimap.background': EDITOR_PANEL_BACKGROUND.light,
    },
  });
}

function getEditorLanguage(filePath?: string) {
  const extension = (filePath?.split('.').pop() ?? '').toLowerCase();
  const languageByExtension: Record<string, string> = {
    bash: 'shell',
    c: 'c',
    cc: 'cpp',
    cjs: 'javascript',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    cxx: 'cpp',
    go: 'go',
    h: 'cpp',
    hh: 'cpp',
    hpp: 'cpp',
    htm: 'html',
    html: 'html',
    ini: 'ini',
    ino: 'cpp',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsonc: 'json',
    jsx: 'javascript',
    less: 'less',
    mjs: 'javascript',
    md: 'markdown',
    ps1: 'powershell',
    py: 'python',
    rs: 'rust',
    scss: 'scss',
    sh: 'shell',
    sql: 'sql',
    svg: 'xml',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };

  return languageByExtension[extension] ?? 'plaintext';
}

function toMonacoPath(filePath?: string) {
  if (!filePath || filePath.startsWith('untitled:')) {
    return undefined;
  }

  return `file:///${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

function configureMonacoFeatures(monaco: Monaco, accentColor: string, themeName: string) {
  defineTantalumEditorThemes(monaco, accentColor);
  configureArduinoCppLanguageSupport(monaco);
  monaco.editor.setTheme(themeName);

  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: true,
    jsx: monaco.languages.typescript.JsxEmit.React,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    target: monaco.languages.typescript.ScriptTarget.Latest,
  });
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: true,
    jsx: monaco.languages.typescript.JsxEmit.React,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    target: monaco.languages.typescript.ScriptTarget.Latest,
  });
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    allowComments: true,
    validate: true,
  });
}

export function IDEWorkspace({
  active = true,
  appName,
  version,
  platform,
  user,
  onSignedOut,
  onOpenSettings,
  sidebar,
  onSidebarChange,
  leftPanelOpen,
  rightPanelOpen,
  bottomPanelOpen,
  onBottomPanelOpenChange,
  onWorkspaceTitleChange,
  workspaceSearchOpen,
  onWorkspaceSearchOpenChange,
  uiPreferences,
  resolvedTheme,
}: IDEWorkspaceProps) {
  const setSidebar = useCallback((nextSidebar: SidebarView) => onSidebarChange(nextSidebar), [onSidebarChange]);
  const [consoleView, setConsoleView] = useState<ConsoleView>('output');
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(() => normalizePanelSizes(DEFAULT_PANEL_SIZES));
  const [activeResizePanel, setActiveResizePanel] = useState<ResizablePanel | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [gitHasChanges, setGitHasChanges] = useState(false);
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [editorReady, setEditorReady] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>(() => [
    { id: Date.now(), level: 'info', message: 'Ready. Open a folder or start writing firmware.' },
  ]);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [boards, setBoards] = useState<BoardDocument[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(() => hasRequiredCloudConfiguration());
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [selectedBoardSecrets, setSelectedBoardSecrets] = useState<BoardSecret | null>(null);
  const [firmwareHistory, setFirmwareHistory] = useState<FirmwareDocument[]>([]);
  const [boardModalOpen, setBoardModalOpen] = useState(false);
  const [provisionModalOpen, setProvisionModalOpen] = useState(false);
  const [releaseModalOpen, setReleaseModalOpen] = useState(false);
  const [boardForm, setBoardForm] = useState<BoardInput>({
    name: '',
    boardType: 'esp32:esp32:esp32',
    wifiSSID: '',
    wifiPassword: '',
  });
  const [provisionPorts, setProvisionPorts] = useState<Array<{ path: string; manufacturer: string }>>([]);
  const [selectedProvisionPort, setSelectedProvisionPort] = useState('');
  const [releaseVersion, setReleaseVersion] = useState('1.0.1');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryResults, setLibraryResults] = useState<LibraryEntry[]>([]);
  const [defaultLibraryResults, setDefaultLibraryResults] = useState<LibraryEntry[]>(FALLBACK_LIBRARY_RESULTS);
  const [installedLibraries, setInstalledLibraries] = useState<LibraryEntry[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesError, setLibrariesError] = useState<string | null>(null);
  const [platformQuery, setPlatformQuery] = useState('');
  const [platformResults, setPlatformResults] = useState<BoardPlatform[]>([]);
  const [defaultPlatformResults, setDefaultPlatformResults] = useState<BoardPlatform[]>(FALLBACK_PLATFORM_RESULTS);
  const [installedPlatforms, setInstalledPlatforms] = useState<BoardPlatform[]>([]);
  const [platformsLoading, setPlatformsLoading] = useState(false);
  const [platformsError, setPlatformsError] = useState<string | null>(null);
  const [leftNavCollapsed, setLeftNavCollapsed] = useState(false);
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const [projectSortMode, setProjectSortMode] = useState<ProjectSortMode>('recent');
  const [projectViewMode, setProjectViewMode] = useState<ProjectViewMode>('grid');
  const [projectTreeRefreshKey, setProjectTreeRefreshKey] = useState(0);
  const [projectDropActive, setProjectDropActive] = useState(false);
  const [projectRenamePrompt, setProjectRenamePrompt] = useState<ProjectFolder | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState('');
  const [projectRemovalPrompt, setProjectRemovalPrompt] = useState<ProjectFolder | null>(null);
  const [fileTreeMoreMenu, setFileTreeMoreMenu] = useState<'workspace' | 'project' | null>(null);

  const deferredLibraryQuery = useDeferredValue(libraryQuery);
  const deferredPlatformQuery = useDeferredValue(platformQuery);
  const deferredProjectQuery = useDeferredValue(projectQuery);
  const librarySearchTerm = deferredLibraryQuery.trim();
  const platformSearchTerm = deferredPlatformQuery.trim();
  const visibleLibraryResults = useMemo(
    () => applyLibraryInstalledState(librarySearchTerm ? libraryResults : defaultLibraryResults, installedLibraries),
    [defaultLibraryResults, installedLibraries, libraryResults, librarySearchTerm],
  );
  const visiblePlatformResults = useMemo(
    () => applyPlatformInstalledState(platformSearchTerm ? platformResults : defaultPlatformResults, installedPlatforms),
    [defaultPlatformResults, installedPlatforms, platformResults, platformSearchTerm],
  );
  const syncedTabs = useMemo(() => tabs.map(syncFileTabDirtyState), [tabs]);
  const activeTab = syncedTabs.find((tab) => tab.id === activeTabId) ?? syncedTabs[0] ?? null;
  const selectedBoard = boards.find((board) => board.$id === selectedBoardId) ?? null;
  const selectedProject = projectFolders.find((project) => project.id === selectedProjectId) ?? projectFolders[0] ?? null;
  const currentWorkspaceProject = useMemo(() => {
    if (!workspacePath) {
      return null;
    }

    const normalizedWorkspacePath = normalizeProjectPath(workspacePath);
    return projectFolders.find((project) => normalizeProjectPath(project.path) === normalizedWorkspacePath) ?? null;
  }, [projectFolders, workspacePath]);
  const visibleProjects = useMemo(() => {
    const query = deferredProjectQuery.trim().toLowerCase();
    const filteredProjects = query
      ? projectFolders.filter((project) => {
          const haystack = `${getProjectDisplayName(project)} ${project.name} ${project.path}`.toLowerCase();
          return haystack.includes(query);
        })
      : projectFolders;

    return [...filteredProjects].sort((left, right) => {
      if (projectSortMode === 'favorites') {
        if (left.favorite !== right.favorite) {
          return left.favorite ? -1 : 1;
        }
      }

      if (projectSortMode === 'name') {
        return getProjectDisplayName(left).localeCompare(getProjectDisplayName(right));
      }

      return getProjectActivityTime(right) - getProjectActivityTime(left) || getProjectDisplayName(left).localeCompare(getProjectDisplayName(right));
    });
  }, [deferredProjectQuery, projectFolders, projectSortMode]);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const tabsRef = useRef<FileTab[]>(tabs);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const editorValueRef = useRef(editorValue);
  const workspaceActiveRef = useRef(active);
  const saveInProgressRef = useRef(false);
  const consoleOutputRef = useRef<HTMLDivElement | null>(null);
  const toastCounterRef = useRef(1);
  const [treeTrashMap] = useState(() => new Map<string, string>());
  const panelSizesRef = useRef<PanelSizes>(panelSizes);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const editorThemeName = resolvedTheme === 'light' ? 'tantalum-minimal-light' : 'tantalum-minimal-dark';
  const activeEditorFilePath = activeTab?.path.startsWith('untitled:') ? activeTab.name : activeTab?.path;
  const activeEditorLanguage = getEditorLanguage(activeEditorFilePath);
  const activeEditorPath = toMonacoPath(activeTab?.path);
  const dirtyWorkspaceFilePaths = useMemo(
    () => syncedTabs.filter((tab) => !tab.path.startsWith('untitled:') && tab.isDirty).map((tab) => tab.path),
    [syncedTabs],
  );
  const fileTreeTheme = useMemo<FileTreeTheme>(
    () => ({
      ...FILE_TREE_THEME,
      fontFamily: 'var(--system-font-family)',
      accent: uiPreferences.accentColor,
      accentTransparent: 'color-mix(in srgb, var(--accent) 16%, transparent)',
    }),
    [uiPreferences.accentColor],
  );

  useEffect(() => {
    onWorkspaceTitleChange?.(workspacePath ? fileNameFromPath(workspacePath) : '');
  }, [onWorkspaceTitleChange, workspacePath]);

  useEffect(() => {
    if (projectFolders.length === 0) {
      setSelectedProjectId(null);
      return;
    }

    if (!selectedProjectId || !projectFolders.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projectFolders[0].id);
    }
  }, [projectFolders, selectedProjectId]);

  function activateTab(nextTab: FileTab) {
    activeTabIdRef.current = nextTab.id;
    editorValueRef.current = nextTab.content;
    setActiveTabId(nextTab.id);
    setEditorValue(nextTab.content);
  }

  function selectTabByPath(tabPath: string) {
    const nextTab = tabs.find((tab) => tab.path === tabPath);
    if (!nextTab) {
      return;
    }

    activateTab(nextTab);
  }

  function openConsolePanel(nextView?: ConsoleView) {
    if (nextView) {
      setConsoleView(nextView);
    }

    onBottomPanelOpenChange(true);
  }

  function toggleConsolePanel() {
    onBottomPanelOpenChange(!bottomPanelOpen);
  }

  function applyPanelSizes(updater: (current: PanelSizes) => PanelSizes) {
    setPanelSizes((current) => {
      const next = updater(current);
      panelSizesRef.current = next;

      if (current.left === next.left && current.right === next.right && current.bottom === next.bottom) {
        return current;
      }

      return next;
    });
  }

  function setSinglePanelSize(panel: ResizablePanel, value: number) {
    applyPanelSizes((current) => normalizePanelSizes({ ...current, [panel]: value }));
  }

  function resetPanelSize(panel: ResizablePanel) {
    setSinglePanelSize(panel, DEFAULT_PANEL_SIZES[panel]);
  }

  function adjustPanelSize(panel: ResizablePanel, delta: number) {
    setSinglePanelSize(panel, panelSizesRef.current[panel] + delta);
  }

  function beginResize(panel: ResizablePanel, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    resizeSessionRef.current = {
      panel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startSize: panelSizesRef.current[panel],
    };
    setActiveResizePanel(panel);
    document.body.classList.add('panel-resizing');
    document.body.classList.remove('panel-resizing-row', 'panel-resizing-column');
    document.body.classList.add(panel === 'bottom' ? 'panel-resizing-row' : 'panel-resizing-column');
  }

  function handleResizerKeyDown(panel: ResizablePanel, event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? PANEL_RESIZE_STEP * 2 : PANEL_RESIZE_STEP;

    if (event.key === 'Enter') {
      event.preventDefault();
      resetPanelSize(panel);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setSinglePanelSize(panel, MIN_PANEL_SIZES[panel]);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setSinglePanelSize(panel, getPanelMaxSize(panel, panelSizesRef.current));
      return;
    }

    if (panel === 'bottom') {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        adjustPanelSize(panel, step);
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        adjustPanelSize(panel, -step);
      }

      return;
    }

    const expandKey = panel === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrinkKey = panel === 'left' ? 'ArrowLeft' : 'ArrowRight';

    if (event.key === expandKey) {
      event.preventDefault();
      adjustPanelSize(panel, step);
      return;
    }

    if (event.key === shrinkKey) {
      event.preventDefault();
      adjustPanelSize(panel, -step);
    }
  }

  function pushConsole(message: string, level: ConsoleEntry['level'] = 'info') {
    if (!message.trim()) {
      return;
    }

    setConsoleEntries((current) => [
      ...current,
      {
        id: Date.now() + Math.random(),
        level,
        message,
      },
    ]);
  }

  function pushToast(message: string, tone: Toast['tone'] = 'info') {
    const id = toastCounterRef.current++;
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4000);
  }

  const refreshGitChangeIndicator = useCallback(async (targetWorkspacePath = workspacePath) => {
    if (!active || !targetWorkspacePath) {
      setGitHasChanges(false);
      return;
    }

    const workspaceResult = await window.tantalum.fs.setWorkspace(targetWorkspacePath);
    if (!workspaceResult.success) {
      setGitHasChanges(false);
      return;
    }

    const statusResult = await window.tantalum.git.getStatus();
    if (!statusResult.success) {
      setGitHasChanges(false);
      return;
    }

    const nextStatus = statusResult.status;
    setGitHasChanges(nextStatus.state === 'repository' && nextStatus.hasChanges);
  }, [active, workspacePath]);

  function handleGitStatusChange(nextStatus: GitStatus) {
    setGitHasChanges(nextStatus.state === 'repository' && nextStatus.hasChanges);
  }

  useEffect(() => {
    void refreshGitChangeIndicator();
    const interval = window.setInterval(() => {
      void refreshGitChangeIndicator();
    }, 8000);

    return () => window.clearInterval(interval);
  }, [refreshGitChangeIndicator]);

  const gitController = useGitWorkspaceController({
    active,
    workspacePath,
    uiPreferences,
    resolvedTheme,
    onOpenFile: (filePath) => {
      setSidebar('explorer');
      void openFile(filePath, { preview: false }).then(() => {
        window.requestAnimationFrame(() => editorRef.current?.focus());
      });
    },
    onRefreshWorkspace: () => {
      refreshFileTree();
      void refreshGitChangeIndicator();
    },
    onStatusChange: handleGitStatusChange,
    pushConsole,
    pushToast,
  });

  useEffect(() => {
    if (!monacoRef.current) {
      return;
    }

    configureMonacoFeatures(monacoRef.current, uiPreferences.accentColor, editorThemeName);
    editorRef.current?.updateOptions({
      fontFamily: uiPreferences.editorFontFamily,
      fontSize: uiPreferences.editorFontSize,
      tabSize: uiPreferences.editorTabSize,
      wordWrap: uiPreferences.editorWordWrap,
    });
  }, [editorThemeName, uiPreferences.accentColor, uiPreferences.editorFontFamily, uiPreferences.editorFontSize, uiPreferences.editorTabSize, uiPreferences.editorWordWrap]);

  function normalizeTreePath(targetPath: string) {
    return targetPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function isPathInsideRoot(targetPath: string, rootPath: string) {
    const normalizedTarget = normalizeTreePath(targetPath);
    const normalizedRoot = normalizeTreePath(rootPath);

    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  }

  function toHostSeparators(targetPath: string, hostPath: string) {
    return hostPath.includes('\\') ? targetPath.replace(/\//g, '\\') : targetPath.replace(/\\/g, '/');
  }

  function relativePathFromRoot(targetPath: string, rootPath: string) {
    const normalizedTarget = targetPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');

    if (normalizedTarget === normalizedRoot) {
      return '';
    }

    if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) {
      return null;
    }

    return normalizedTarget.slice(normalizedRoot.length + 1);
  }

  function remapPathWithinRoot(targetPath: string, sourceRoot: string, destinationRoot: string) {
    const relativePath = relativePathFromRoot(targetPath, sourceRoot);
    if (relativePath === null) {
      return targetPath;
    }

    if (!relativePath) {
      return destinationRoot;
    }

    return joinPath(destinationRoot, toHostSeparators(relativePath, destinationRoot));
  }

  function mapDirectoryItemsToTreeNodes(items: Array<{ name: string; path: string; isDirectory: boolean; extension: string | null }>): FileTreeNode[] {
    return items
      .filter((item) => item.name !== FILE_TREE_INTERNAL_TRASH_DIR && !item.name.startsWith('.trash_'))
      .map((item) => ({
        name: item.name,
        path: item.path,
        type: item.isDirectory ? 'directory' : 'file',
        extension: item.extension ?? undefined,
      }));
  }

  function refreshFileTree() {
    setFileTreeRefreshKey((current) => current + 1);
  }

  function refreshProjectTree() {
    setProjectTreeRefreshKey((current) => current + 1);
  }

  function closeTabsForPath(targetPath: string, type: FileTreeItemType) {
    setTabs((current) => {
      const nextTabs = current.filter((tab) => {
        if (tab.path.startsWith('untitled:')) {
          return true;
        }

        if (type === 'file') {
          return tab.path !== targetPath;
        }

        return !isPathInsideRoot(tab.path, targetPath);
      });

      tabsRef.current = nextTabs;
      return nextTabs;
    });

    setActiveTabId((current) => {
      if (!current) {
        return current;
      }

      if (type === 'file') {
        if (isSameFileTabPath(current, targetPath)) {
          activeTabIdRef.current = null;
          return null;
        }
        activeTabIdRef.current = current;
        return current;
      }

      const nextActiveTabId = isPathInsideRoot(current, targetPath) ? null : current;
      activeTabIdRef.current = nextActiveTabId;
      return nextActiveTabId;
    });
  }

  function remapOpenTabs(sourceRoot: string, destinationRoot: string) {
    setTabs((current) => {
      const nextTabs = current.map((tab) => {
        if (tab.path.startsWith('untitled:') || !isPathInsideRoot(tab.path, sourceRoot)) {
          return tab;
        }

        const nextPath = remapPathWithinRoot(tab.path, sourceRoot, destinationRoot);
        return {
          ...tab,
          id: nextPath,
          path: nextPath,
          name: fileNameFromPath(nextPath),
        };
      });

      tabsRef.current = nextTabs;
      return nextTabs;
    });

    setActiveTabId((current) => {
      const nextActiveTabId = current && isPathInsideRoot(current, sourceRoot) ? remapPathWithinRoot(current, sourceRoot, destinationRoot) : current;
      activeTabIdRef.current = nextActiveTabId;
      return nextActiveTabId;
    });
  }

  async function clearInternalTrash(workspaceRoot: string) {
    const trashPath = joinPath(workspaceRoot, FILE_TREE_INTERNAL_TRASH_DIR);
    const result = await window.tantalum.fs.deletePath(trashPath);

    if (!result.success && !result.error.toLowerCase().includes('does not exist')) {
      pushConsole(`Unable to clean workspace trash: ${result.error}`, 'error');
    }
  }

  async function ensureInternalTrashFolder(workspaceRoot: string) {
    const result = await window.tantalum.fs.createFolder(workspaceRoot, FILE_TREE_INTERNAL_TRASH_DIR);

    if (!result.success && !result.error.toLowerCase().includes('already exists')) {
      throw new Error(result.error);
    }

    return joinPath(workspaceRoot, FILE_TREE_INTERNAL_TRASH_DIR);
  }

  async function copyWorkspaceEntry(sourcePath: string, destinationPath: string): Promise<string> {
    const directoryResult = await window.tantalum.fs.readDirectory(sourcePath);
    if (directoryResult.success) {
      const createFolderResult = await window.tantalum.fs.createFolder(parentPath(destinationPath), fileNameFromPath(destinationPath));
      if (!createFolderResult.success) {
        throw new Error(createFolderResult.error);
      }

      for (const item of directoryResult.items) {
        await copyWorkspaceEntry(item.path, joinPath(destinationPath, item.name));
      }

      return createFolderResult.path;
    }

    const fileResult = await window.tantalum.fs.readFile(sourcePath);
    if (!fileResult.success) {
      throw new Error(fileResult.error);
    }

    const createFileResult = await window.tantalum.fs.createFile(parentPath(destinationPath), fileNameFromPath(destinationPath), fileResult.content);
    if (!createFileResult.success) {
      throw new Error(createFileResult.error);
    }

    return createFileResult.path;
  }

  async function syncBoardSecrets(boardId: string) {
    const result = await window.tantalum.secrets.getBoardSecrets(boardId);
    if (result.success) {
      setSelectedBoardSecrets((result.secrets as BoardSecret | null) ?? null);
    }
  }

  async function refreshBoardsList() {
    if (!hasRequiredCloudConfiguration()) {
      setBoardsLoading(false);
      setBoardsError('Cloud configuration is incomplete.');
      return;
    }

    setBoardsLoading(true);
    setBoardsError(null);

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
      const message = error instanceof Error ? error.message : 'Unable to load boards.';
      setBoardsError(message);
      pushConsole(message, 'error');
    } finally {
      setBoardsLoading(false);
    }
  }

  async function refreshFirmware(board: BoardDocument | null) {
    if (!board) {
      setFirmwareHistory([]);
      return;
    }

    try {
      const history = await listFirmwareHistory(board.$id);
      setFirmwareHistory(history);
      setReleaseVersion(nextSemver(board.firmwareVersion || history[0]?.version || '1.0.0'));
    } catch (error) {
      pushConsole(error instanceof Error ? error.message : 'Unable to load firmware history.', 'error');
    }
  }

  async function refreshInstalledLibraries() {
    const result = await window.tantalum.toolchain.listInstalledLibraries();
    if (!result.success) {
      pushConsole(result.error, 'error');
      setInstalledLibraries([]);
      return [];
    }

    const nextLibraries = (result.libraries as LibraryEntry[]).map((library) => ({
      ...library,
      installed: true,
    }));

    setInstalledLibraries(nextLibraries);
    return nextLibraries;
  }

  async function refreshInstalledPlatforms() {
    const result = await window.tantalum.toolchain.listInstalledPlatforms();
    if (!result.success) {
      pushConsole(result.error, 'error');
      setInstalledPlatforms([]);
      return [];
    }

    const nextPlatforms = (result.platforms as BoardPlatform[]) ?? [];
    setInstalledPlatforms(nextPlatforms);
    return nextPlatforms;
  }

  async function refreshDefaultLibraries() {
    setLibrariesError(null);

    const result = await withManagerTimeout(window.tantalum.toolchain.getFeaturedLibraries());
    if (!result) {
      return FALLBACK_LIBRARY_RESULTS;
    }

    try {
      if (!result.success) {
        pushConsole(result.error, 'error');
        return FALLBACK_LIBRARY_RESULTS;
      }

      const nextLibraries = limitManagerResults((result.libraries as LibraryEntry[]) ?? []);
      const visibleLibraries = nextLibraries.length > 0 ? nextLibraries : FALLBACK_LIBRARY_RESULTS;
      setDefaultLibraryResults(visibleLibraries);
      return visibleLibraries;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load libraries.';
      pushConsole(message, 'error');
      return FALLBACK_LIBRARY_RESULTS;
    }
  }

  async function refreshDefaultPlatforms() {
    setPlatformsError(null);

    const result = await withManagerTimeout(window.tantalum.toolchain.searchBoardPlatforms(''));
    if (!result) {
      return FALLBACK_PLATFORM_RESULTS;
    }

    try {
      if (!result.success) {
        pushConsole(result.error, 'error');
        return FALLBACK_PLATFORM_RESULTS;
      }

      const nextPlatforms = limitManagerResults((result.platforms as BoardPlatform[]) ?? []);
      const visiblePlatforms = nextPlatforms.length > 0 ? nextPlatforms : FALLBACK_PLATFORM_RESULTS;
      setDefaultPlatformResults(visiblePlatforms);
      return visiblePlatforms;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load board cores.';
      pushConsole(message, 'error');
      return FALLBACK_PLATFORM_RESULTS;
    }
  }

  async function openWorkspace(folderPath: string) {
    const result = await window.tantalum.fs.setWorkspace(folderPath);
    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    treeTrashMap.clear();
    setWorkspacePath(result.path);
    refreshFileTree();
    void refreshGitChangeIndicator(result.path);
    pushConsole(`Opened workspace: ${result.path}`, 'success');
    void clearInternalTrash(result.path);
  }

  async function openFolderPicker() {
    const result = await window.tantalum.fs.openFolder();
    if (result.success) {
      await openWorkspace(result.path);
    }
  }

  async function refreshProjectFolders(preferredProjectId: string | null = selectedProjectId) {
    const result = await window.tantalum.projects.list();
    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    setProjectFolders(result.projects);
    const nextSelectedProjectId =
      preferredProjectId && result.projects.some((project) => project.id === preferredProjectId)
        ? preferredProjectId
        : selectedProjectId && result.projects.some((project) => project.id === selectedProjectId)
          ? selectedProjectId
          : result.projects[0]?.id ?? null;

    setSelectedProjectId(nextSelectedProjectId);
  }

  async function addProjectFolderPath(projectPath: string) {
    const result = await window.tantalum.projects.add(projectPath);
    if (!result.success) {
      pushToast(result.error, 'error');
      return null;
    }

    await refreshProjectFolders(result.project.id);
    pushToast(result.alreadyExists ? `${getProjectDisplayName(result.project)} is already in My Projects.` : `Added ${getProjectDisplayName(result.project)} to My Projects.`, 'success');
    return result.project;
  }

  async function addCurrentWorkspaceToProjects() {
    if (!workspacePath) {
      pushToast('Open a workspace before adding it to My Projects.', 'info');
      return;
    }

    if (currentWorkspaceProject) {
      setProjectRemovalPrompt(currentWorkspaceProject);
      return;
    }

    setBusyAction('add-current-project');
    try {
      await addProjectFolderPath(workspacePath);
    } finally {
      setBusyAction(null);
    }
  }

  async function pickProjectFolder() {
    const result = await window.tantalum.projects.pickFolder();
    if (result.success) {
      await addProjectFolderPath(result.path);
    }
  }

  async function toggleProjectFavorite(project: ProjectFolder) {
    const result = await window.tantalum.projects.update(project.id, { favorite: !project.favorite });
    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    await refreshProjectFolders(result.project.id);
  }

  function renameProjectFolder(project: ProjectFolder) {
    setProjectRenamePrompt(project);
    setProjectRenameValue(project.displayName || project.name);
  }

  async function submitProjectRename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!projectRenamePrompt) {
      return;
    }

    const project = projectRenamePrompt;
    const nextName = projectRenameValue.trim();
    setBusyAction(`rename-project:${project.id}`);
    try {
      const result = await window.tantalum.projects.update(project.id, { displayName: nextName });
      if (!result.success) {
        pushToast(result.error, 'error');
        return;
      }

      await refreshProjectFolders(result.project.id);
      setProjectRenamePrompt(null);
      setProjectRenameValue('');
      pushToast(`Renamed ${getProjectDisplayName(result.project)}.`, 'success');
    } finally {
      setBusyAction(null);
    }
  }

  async function locateProjectFolder(project: ProjectFolder) {
    const pickResult = await window.tantalum.projects.pickFolder();
    if (!pickResult.success) {
      return;
    }

    const updateResult = await window.tantalum.projects.update(project.id, { path: pickResult.path });
    if (!updateResult.success) {
      pushToast(updateResult.error, 'error');
      return;
    }

    await refreshProjectFolders(updateResult.project.id);
    pushToast(`Relinked ${getProjectDisplayName(updateResult.project)}.`, 'success');
  }

  function removeProjectFolder(project: ProjectFolder) {
    setProjectRemovalPrompt(project);
  }

  async function confirmProjectFolderRemoval() {
    if (!projectRemovalPrompt) {
      return;
    }

    const project = projectRemovalPrompt;
    setBusyAction(`remove-project:${project.id}`);
    try {
      const result = await window.tantalum.projects.remove(project.id);
      if (!result.success) {
        pushToast(result.error, 'error');
        return;
      }

      setProjectFolders(result.projects);
      setSelectedProjectId((current) => (current && result.projects.some((entry) => entry.id === current) ? current : result.projects[0]?.id ?? null));
      setProjectRemovalPrompt(null);
      pushToast(`Removed ${getProjectDisplayName(project)} from My Projects.`, 'info');
    } finally {
      setBusyAction(null);
    }
  }

  async function copyProjectPath(project: ProjectFolder) {
    try {
      await navigator.clipboard.writeText(project.path);
      pushToast('Project path copied.', 'success');
    } catch {
      pushToast('Unable to copy the project path.', 'error');
    }
  }

  async function revealProjectFolder(project: ProjectFolder) {
    const result = await window.tantalum.shell.openPath(project.path);
    if (!result.success) {
      pushToast(result.error, 'error');
    }
  }

  async function inspectProjectFolder(project: ProjectFolder) {
    const result = await window.tantalum.projects.inspect(project.id);
    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    setProjectFolders((current) => current.map((entry) => (entry.id === result.project.id ? result.project : entry)));
  }

  async function openProjectWorkspace(project: ProjectFolder) {
    if (!project.exists) {
      pushToast('Locate this project folder before opening it.', 'info');
      return;
    }

    await openWorkspace(project.path);
    await refreshProjectFolders(project.id);
    setSidebar('explorer');
  }

  async function openProjectFile(project: ProjectFolder, filePath: string, options?: { preview?: boolean }) {
    if (!project.exists) {
      pushToast('Locate this project folder before opening files.', 'info');
      return;
    }

    await openWorkspace(project.path);
    await openFile(filePath, options);
    await refreshProjectFolders(project.id);
    setSidebar('explorer');
  }

  function getDroppedProjectFolderPaths(event: ReactDragEvent<HTMLElement>) {
    const droppedPaths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return [...new Set(droppedPaths)];
  }

  async function handleProjectDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    setProjectDropActive(false);

    const droppedPaths = getDroppedProjectFolderPaths(event);
    if (droppedPaths.length === 0) {
      pushToast('Drop a folder from your file manager to add it.', 'info');
      return;
    }

    let selectedAddedProjectId: string | null = null;
    let addedCount = 0;
    let duplicateCount = 0;
    const errors: string[] = [];

    for (const droppedPath of droppedPaths) {
      const result = await window.tantalum.projects.add(droppedPath);
      if (!result.success) {
        errors.push(result.error);
        continue;
      }

      selectedAddedProjectId = result.project.id;
      if (result.alreadyExists) {
        duplicateCount += 1;
      } else {
        addedCount += 1;
      }
    }

    await refreshProjectFolders(selectedAddedProjectId);

    if (addedCount > 0) {
      pushToast(`Added ${addedCount} ${addedCount === 1 ? 'project' : 'projects'} to My Projects.`, 'success');
    } else if (duplicateCount > 0 && errors.length === 0) {
      pushToast('Dropped folders are already in My Projects.', 'info');
    }

    if (errors.length > 0) {
      pushToast(errors[0], 'error');
    }
  }

  function handleProjectDragOver(event: ReactDragEvent<HTMLElement>) {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setProjectDropActive(true);
    }
  }

  function handleProjectDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setProjectDropActive(false);
    }
  }

  function createFileTreeFs(treeRoot: string | null): FileTreeFsAdapter {
    return {
      readDirectory: async (dirPath) => {
        const result = await window.tantalum.fs.readDirectory(dirPath);
        if (!result.success) {
          throw new Error(result.error);
        }

        return mapDirectoryItemsToTreeNodes(result.items);
      },
      readFile: async (filePath) => {
        const result = await window.tantalum.fs.readFile(filePath);
        if (!result.success) {
          throw new Error(result.error);
        }

        return result.content;
      },
      openInFileManager: async (targetPath) => {
        const result = await window.tantalum.shell.openPath(targetPath);
        if (!result.success) {
          throw new Error(result.error);
        }
      },
      createFile: async (targetPath) => {
        const result = await window.tantalum.fs.createFile(parentPath(targetPath), fileNameFromPath(targetPath), '');
        if (!result.success) {
          throw new Error(result.error);
        }

        return result.path;
      },
      createFolder: async (targetPath) => {
        const result = await window.tantalum.fs.createFolder(parentPath(targetPath), fileNameFromPath(targetPath));
        if (!result.success) {
          throw new Error(result.error);
        }

        return result.path;
      },
      renameItem: async (oldPath, newPath) => {
        const mappedTrashPath = treeTrashMap.get(oldPath);
        if (mappedTrashPath) {
          const restoreResult = await window.tantalum.fs.rename(mappedTrashPath, newPath);
          if (!restoreResult.success) {
            throw new Error(restoreResult.error);
          }

          treeTrashMap.delete(oldPath);
          return restoreResult.path;
        }

        if (treeRoot && fileNameFromPath(newPath).startsWith('.trash_')) {
          const trashRoot = await ensureInternalTrashFolder(treeRoot);
          const hiddenTrashPath = joinPath(trashRoot, fileNameFromPath(newPath));
          const trashResult = await window.tantalum.fs.rename(oldPath, hiddenTrashPath);
          if (!trashResult.success) {
            throw new Error(trashResult.error);
          }

          treeTrashMap.set(newPath, hiddenTrashPath);
          return newPath;
        }

        const result = await window.tantalum.fs.rename(oldPath, newPath);
        if (!result.success) {
          throw new Error(result.error);
        }

        return result.path;
      },
      copyItem: async (oldPath, newPath) => copyWorkspaceEntry(oldPath, newPath),
    };
  }

  const workspaceFileTreeFs = createFileTreeFs(workspacePath);
  const selectedProjectFileTreeFs = createFileTreeFs(selectedProject?.path ?? null);

  function updateTabContent(tabPath: string, nextContent: string) {
    setTabs((current) => {
      let changed = false;
      const nextTabs = current.map((tab) => {
        if (!isSameFileTabPath(tab.path, tabPath)) {
          return tab;
        }

        const savedContent = getFileTabSavedContent(tab);
        const isDirty = isTemporaryFileTab(tab) || nextContent !== savedContent;

        if (tab.content === nextContent && tab.savedContent === savedContent && tab.isDirty === isDirty) {
          return tab;
        }

        changed = true;
        return {
          ...tab,
          content: nextContent,
          savedContent,
          isDirty,
          isPreviewFile: false,
          fileState: (tab.fileState === 'temporary' ? 'temporary' : 'saved') as FileTabState,
          type: 'file' as const,
        };
      });

      if (!changed) {
        return current;
      }

      tabsRef.current = nextTabs;
      return nextTabs;
    });
  }

  const refreshActiveEditorDiagnostics = useCallback((filePath = activeEditorFilePath) => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel() ?? null;

    if (!monaco || !model) {
      return;
    }

    updateArduinoCppDiagnostics(monaco, model, filePath);
  }, [activeEditorFilePath]);

  async function openFile(filePath: string, options?: { preview?: boolean }) {
    const shouldPreview = options?.preview ?? true;
    const existing = tabs.find((tab) => tab.path === filePath);
    if (existing) {
      if (!shouldPreview && existing.isPreviewFile) {
        const pinnedTab: FileTab = {
          ...existing,
          isPreviewFile: false,
          fileState: 'saved',
          type: 'file',
        };

        setTabs((current) => {
          const nextTabs = openEditorTab(current, pinnedTab, { isPreview: false });
          tabsRef.current = nextTabs;
          return nextTabs;
        });
        activateTab(pinnedTab);
        return;
      }

      activateTab(existing);
      return;
    }

    const result = await window.tantalum.fs.readFile(filePath);
    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    const nextTab = createSavedTab(filePath, result.content, { isPreview: shouldPreview });

    setTabs((current) => {
      const nextTabs = openEditorTab(current, nextTab, { isPreview: shouldPreview });
      tabsRef.current = nextTabs;
      return nextTabs;
    });
    activateTab(nextTab);
    void window.tantalum.fs.addRecentFile(filePath);
  }

  async function openFileWithWorkspace(filePath: string) {
    if (!workspacePath || !isPathInsideRoot(filePath, workspacePath)) {
      await openWorkspace(parentPath(filePath));
    }

    await openFile(filePath, { preview: false });
  }

  function revealEditorRange(lineNumber: number, column = 1, endColumn = column) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const editorInstance = editorRef.current;
        if (!editorInstance) {
          return;
        }

        editorInstance.setSelection({
          startLineNumber: lineNumber,
          startColumn: column,
          endLineNumber: lineNumber,
          endColumn: Math.max(column, endColumn),
        });
        editorInstance.revealLineInCenter(lineNumber);
        editorInstance.focus();
      });
    });
  }

  async function openWorkspaceSearchResult(result: WorkspaceSearchResult) {
    if (result.type === 'folder') {
      setSidebar('explorer');
      pushToast(`Folder: ${result.relativePath}`, 'info');
      return;
    }

    setSidebar('explorer');
    await openFile(result.path, { preview: false });

    if (result.type === 'text' && result.lineNumber) {
      revealEditorRange(result.lineNumber, result.column ?? 1, result.endColumn ?? result.column ?? 1);
    }
  }

  function applyWorkspaceReplaceChanges(changedFiles: WorkspaceReplaceChangedFile[]) {
    if (changedFiles.length === 0) {
      return;
    }

    const changedFileMap = new Map(changedFiles.map((file) => [file.path, file]));

    setTabs((current) => {
      const nextTabs = current.map((tab) => {
        const changedFile = changedFileMap.get(tab.path);
        if (!changedFile) {
          return tab;
        }

        return {
          ...tab,
          content: changedFile.content,
          savedContent: changedFile.content,
          isDirty: false,
          fileState: 'saved' as const,
          type: 'file' as const,
        };
      });

      tabsRef.current = nextTabs;
      return nextTabs;
    });

    const activeChange = activeTabIdRef.current ? changedFileMap.get(activeTabIdRef.current) : null;
    if (activeChange) {
      editorValueRef.current = activeChange.content;
      setEditorValue(activeChange.content);
      refreshActiveEditorDiagnostics(activeChange.path);
    }

    refreshFileTree();
    void refreshGitChangeIndicator();
  }

  function createNewTab() {
    const nextTab = createUntitledTab();

    setSidebar('explorer');
    setTabs((current) => {
      const nextTabs = [...current, nextTab];
      tabsRef.current = nextTabs;
      return nextTabs;
    });
    activateTab(nextTab);
  }

  function closeTab(tabPath: string) {
    const closingIndex = tabs.findIndex((tab) => tab.path === tabPath);
    if (closingIndex === -1) {
      return;
    }

    const closingTab = syncFileTabDirtyState(tabs[closingIndex]);
    if (closingTab.isDirty && !window.confirm(`Close ${closingTab.name} without saving your changes?`)) {
      return;
    }

    const result = closeEditorTab(tabs, tabPath, activeTab?.path ?? null);

    if (result.tabs.length === 0) {
      tabsRef.current = [];
      activeTabIdRef.current = null;
      editorValueRef.current = '';
      setTabs([]);
      setActiveTabId(null);
      setEditorValue('');
      return;
    }

    tabsRef.current = result.tabs;
    setTabs(result.tabs);

    if (result.activeTabPath) {
      const fallbackTab = result.tabs.find((tab) => tab.path === result.activeTabPath);
      if (fallbackTab) {
        activateTab(fallbackTab);
        return;
      }
    }

    activeTabIdRef.current = null;
    setActiveTabId(null);
  }

  function handleTabReorder(fromIndex: number, toIndex: number) {
    setTabs((current) => {
      const nextTabs = reorderEditorTabs(current, fromIndex, toIndex);
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  }

  async function saveActiveTab(saveAs = false) {
    const tabToSave =
      tabsRef.current.find((tab) => tab.id === activeTabIdRef.current) ??
      tabsRef.current.find((tab) => tab.id === activeTab?.id) ??
      activeTab;

    if (!tabToSave) {
      return;
    }

    if (saveInProgressRef.current) {
      return;
    }

    saveInProgressRef.current = true;
    try {
      let destinationPath = tabToSave.path;
      if (saveAs || tabToSave.path.startsWith('untitled:')) {
        const result = await window.tantalum.fs.showSaveDialog({
          defaultPath: workspacePath ? joinPath(workspacePath, tabToSave.name || 'sketch.ino') : tabToSave.name,
          filters: [{ name: 'Arduino Sketch', extensions: ['ino', 'cpp', 'c', 'h'] }],
        });

        if (!result.success) {
          return;
        }

        destinationPath = result.path;
      }

      const contentToSave = editorRef.current?.getValue() ?? editorValueRef.current;
      const writeResult = await window.tantalum.fs.writeFile(destinationPath, contentToSave);
      if (!writeResult.success) {
        pushToast(writeResult.error, 'error');
        return;
      }

      const nextName = fileNameFromPath(destinationPath);
      setTabs((current) => {
        const baseTab: FileTab = {
          ...tabToSave,
          id: destinationPath,
          path: destinationPath,
          name: nextName,
          content: contentToSave,
          savedContent: contentToSave,
          isPreviewFile: false,
          isDirty: false,
          type: 'file',
          fileState: 'saved',
        };

        const nextTabs = current
          .filter((tab) => tab.id === tabToSave.id || !isSameFileTabPath(tab.path, destinationPath))
          .map((tab) => (tab.id === tabToSave.id ? baseTab : tab));

        tabsRef.current = nextTabs;
        return nextTabs;
      });
      activeTabIdRef.current = destinationPath;
      editorValueRef.current = contentToSave;
      setActiveTabId(destinationPath);
      setEditorValue(contentToSave);
      void window.tantalum.fs.addRecentFile(destinationPath);

      if (workspacePath && isPathInsideRoot(destinationPath, workspacePath) && isFirmwareFileName(nextName)) {
        refreshFileTree();
      }

      void refreshGitChangeIndicator();
    } finally {
      saveInProgressRef.current = false;
    }
  }

  async function handleCompile() {
    if (!activeTab) {
      return;
    }

    setBusyAction('compile');
    pushConsole(`Compiling ${activeTab.name} for ${selectedBoard?.boardType ?? 'arduino:avr:uno'}...`);

    const result = await window.tantalum.toolchain.compile({
      code: editorValue,
      board: selectedBoard?.boardType ?? 'arduino:avr:uno',
    });

    setBusyAction(null);

    if (!result.success) {
      pushConsole(result.error, 'error');
      pushToast('Compilation failed.', 'error');
      return;
    }

    pushConsole(normalizeOutput(result.output || 'Compilation finished.'), 'success');
    pushToast(`Compiled ${result.filename}`, 'success');
  }

  async function handleUploadRelease() {
    if (!selectedBoard) {
      pushToast('Choose a board before uploading firmware.', 'info');
      return;
    }

    if (!releaseVersion.match(/^\d+\.\d+\.\d+$/)) {
      pushToast('Use semantic versioning like 1.0.1.', 'error');
      return;
    }

    setBusyAction('upload');
    pushConsole(`Building ${selectedBoard.name} firmware release ${releaseVersion}...`);

    const compileResult = await window.tantalum.toolchain.compile({
      code: editorValue,
      board: selectedBoard.boardType,
    });

    if (!compileResult.success) {
      setBusyAction(null);
      pushConsole(compileResult.error, 'error');
      pushToast('Compilation failed before upload.', 'error');
      return;
    }

    try {
      const checksum = await sha256Hex(compileResult.binData);
      await uploadFirmwareRelease({
        user,
        board: selectedBoard,
        version: releaseVersion,
        notes: releaseNotes,
        checksum,
        compileResult: {
          filename: compileResult.filename,
          binData: compileResult.binData,
          binSize: compileResult.binSize,
        },
      });

      await refreshBoardsList();
      await refreshFirmware(selectedBoard);
      setReleaseModalOpen(false);
      setReleaseNotes('');
      setReleaseVersion(nextSemver(releaseVersion));
      pushToast(`Release ${releaseVersion} uploaded for ${selectedBoard.name}`, 'success');
      pushConsole('Firmware uploaded to Appwrite storage and marked as current.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Firmware upload failed.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleProvisionBoard() {
    if (!selectedBoard || !selectedProvisionPort) {
      pushToast('Select both a board and a USB port.', 'info');
      return;
    }

    const secretResult = await window.tantalum.secrets.getBoardSecrets(selectedBoard.$id);
    if (!secretResult.success || !secretResult.secrets?.apiToken || !secretResult.secrets?.wifiPassword) {
      pushToast('Local board secrets are missing. Re-create or rotate the board token.', 'error');
      return;
    }

    setBusyAction('provision');
    pushConsole(`Provisioning ${selectedBoard.name} on ${selectedProvisionPort}...`);

    const result = await window.tantalum.toolchain.provisionBoard({
      board: selectedBoard,
      port: selectedProvisionPort,
      secrets: secretResult.secrets,
      appwriteConfig: {
        endpoint: appwriteConfig.endpoint,
        projectId: appwriteConfig.projectId,
        deviceGatewayFunctionId: appwriteConfig.deviceGatewayFunctionId,
        firmwareBucketId: appwriteConfig.firmwareBucketId,
      },
    });

    setBusyAction(null);

    if (!result.success) {
      pushConsole(result.error, 'error');
      pushToast('Provisioning failed.', 'error');
      return;
    }

    await updateBoard(selectedBoard.$id, {
      status: 'pending',
      lastProvisionedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await refreshBoardsList();
    setProvisionModalOpen(false);
    pushToast(`${selectedBoard.name} flashed successfully.`, 'success');
    pushConsole(normalizeOutput(result.output || result.message || 'Provisioning complete.'), 'success');
  }

  async function handleCreateBoard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!boardForm.name || !boardForm.boardType || !boardForm.wifiSSID || !boardForm.wifiPassword) {
      pushToast('Complete the board name, type, SSID, and WiFi password.', 'error');
      return;
    }

    setBusyAction('create-board');
    try {
      const created = await createBoard(boardForm, user);
      await window.tantalum.secrets.setBoardSecrets({
        boardId: created.board.$id,
        apiToken: created.apiToken,
        wifiPassword: boardForm.wifiPassword,
      });
      await refreshBoardsList();
      setSelectedBoardId(created.board.$id);
      setBoardModalOpen(false);
      setBoardForm({ name: '', boardType: 'esp32:esp32:esp32', wifiSSID: '', wifiPassword: '' });
      pushToast(`Added ${created.board.name}`, 'success');
      pushConsole(`Board ${created.board.name} created. Token stored locally on this machine.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to create the board.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRotateBoardToken() {
    if (!selectedBoard) {
      return;
    }

    setBusyAction('rotate-token');
    try {
      const rotated = await rotateBoardToken(selectedBoard.$id);
      await window.tantalum.secrets.setBoardSecrets({
        boardId: selectedBoard.$id,
        apiToken: rotated.apiToken,
        wifiPassword: selectedBoardSecrets?.wifiPassword ?? '',
      });
      await refreshBoardsList();
      await syncBoardSecrets(selectedBoard.$id);
      pushToast(`Rotated token for ${selectedBoard.name}`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to rotate the board token.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteBoard() {
    if (!selectedBoard) {
      return;
    }

    if (!window.confirm(`Delete ${selectedBoard.name}?`)) {
      return;
    }

    setBusyAction('delete-board');
    try {
      await deleteBoard(selectedBoard.$id);
      await window.tantalum.secrets.deleteBoardSecrets(selectedBoard.$id);
      await refreshBoardsList();
      setFirmwareHistory([]);
      pushToast(`${selectedBoard.name} deleted.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to delete board.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePromoteFirmware(firmware: FirmwareDocument) {
    if (!selectedBoard) {
      return;
    }

    try {
      await markFirmwareAsCurrent(selectedBoard, firmware);
      await refreshBoardsList();
      await refreshFirmware(selectedBoard);
      pushToast(`Promoted ${firmware.version} to current`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to promote firmware.', 'error');
    }
  }

  async function handleDeleteFirmware(firmware: FirmwareDocument) {
    if (!window.confirm(`Delete firmware ${firmware.version}?`)) {
      return;
    }

    try {
      await deleteFirmwareRelease(firmware);
      await refreshFirmware(selectedBoard);
      pushToast(`Deleted firmware ${firmware.version}`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to delete firmware.', 'error');
    }
  }

  async function handleInstallLibrary(library: LibraryEntry) {
    setBusyAction(`library:${library.name}`);
    const result = await window.tantalum.toolchain.installLibrary({ name: library.name });
    setBusyAction(null);

    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    pushConsole(normalizeOutput(result.output || `Installed ${library.name}`), 'success');
    pushToast(`Installed ${library.name}`, 'success');
    await refreshInstalledLibraries();
  }

  async function handleInstallPlatform(platform: BoardPlatform) {
    setBusyAction(`platform:${platform.id}`);
    const result = await window.tantalum.toolchain.installBoardPackage({ packageName: `${platform.id}@${platform.latest || platform.version || 'latest'}` });
    setBusyAction(null);

    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    pushConsole(normalizeOutput(result.output || `Installed ${platform.id}`), 'success');
    pushToast(`Installed ${platform.name}`, 'success');
    await refreshInstalledPlatforms();
  }

  async function handleRemovePlatform(platform: BoardPlatform) {
    if (!window.confirm(`Remove ${platform.name}?`)) {
      return;
    }

    setBusyAction(`remove-platform:${platform.id}`);
    const result = await window.tantalum.toolchain.removeBoardPackage({ packageName: platform.id });
    setBusyAction(null);

    if (!result.success) {
      pushToast(result.error, 'error');
      return;
    }

    pushConsole(normalizeOutput(result.output || `Removed ${platform.id}`), 'success');
    pushToast(`Removed ${platform.name}`, 'success');
    await refreshInstalledPlatforms();
  }

  const handleMenuAction = useEffectEvent(async (action: MenuAction) => {
    switch (action.type) {
      case 'new-file':
        createNewTab();
        break;
      case 'open-file': {
        const result = await window.tantalum.fs.openFile();
        if (result.success) {
          await openFileWithWorkspace(result.path);
        }
        break;
      }
      case 'open-folder': {
        const result = await window.tantalum.fs.openFolder();
        if (result.success) {
          await openWorkspace(result.path);
        }
        break;
      }
      case 'open-recent-workspace':
        await openWorkspace(action.folderPath);
        break;
      case 'save-file':
        await saveActiveTab(false);
        break;
      case 'save-file-as':
        await saveActiveTab(true);
        break;
      case 'show-sketch-folder':
        if (activeTab && !activeTab.path.startsWith('untitled:')) {
          await window.tantalum.shell.openPath(parentPath(activeTab.path));
        } else if (workspacePath) {
          await window.tantalum.shell.openPath(workspacePath);
        }
        break;
      case 'undo':
        editorRef.current?.trigger('menu', 'undo', null);
        break;
      case 'redo':
        editorRef.current?.trigger('menu', 'redo', null);
        break;
      case 'cut':
        editorRef.current?.trigger('menu', 'editor.action.clipboardCutAction', null);
        break;
      case 'copy':
        editorRef.current?.trigger('menu', 'editor.action.clipboardCopyAction', null);
        break;
      case 'paste':
        editorRef.current?.trigger('menu', 'editor.action.clipboardPasteAction', null);
        break;
      case 'select-all':
        editorRef.current?.trigger('menu', 'editor.action.selectAll', null);
        break;
      case 'toggle-comment':
        editorRef.current?.trigger('keyboard', 'editor.action.commentLine', null);
        break;
      case 'find':
        editorRef.current?.trigger('keyboard', 'actions.find', null);
        break;
      case 'find-in-workspace':
        if (!workspacePath) {
          pushToast('Open a folder before searching the workspace.', 'info');
          return;
        }
        onWorkspaceSearchOpenChange(true);
        break;
      case 'find-next':
        editorRef.current?.trigger('keyboard', 'editor.action.nextMatchFindAction', null);
        break;
      case 'find-previous':
        editorRef.current?.trigger('keyboard', 'editor.action.previousMatchFindAction', null);
        break;
      case 'show-explorer':
        setSidebar('explorer');
        break;
      case 'show-boards':
        setSidebar('boards');
        break;
      case 'show-libraries':
        setSidebar('libraries');
        break;
      case 'show-git':
        setSidebar('git');
        break;
      case 'show-platforms':
        setSidebar('platforms');
        break;
      case 'show-my-projects':
        setSidebar('my-projects');
        break;
      case 'show-output':
        openConsolePanel('output');
        break;
      case 'compile':
        await handleCompile();
        break;
      case 'upload-cloud':
        setReleaseModalOpen(true);
        break;
      case 'open-library-manager':
        setSidebar('libraries');
        break;
      case 'open-board-manager':
        setSidebar('platforms');
        break;
      case 'install-esp32-support': {
        const result = await window.tantalum.toolchain.installEsp32Support();
        if (!result.success) {
          pushToast(result.error, 'error');
        } else {
          pushConsole(normalizeOutput(result.output || result.message || 'ESP32 support installed.'), 'success');
          pushToast('ESP32 support installed.', 'success');
          await refreshInstalledPlatforms();
        }
        break;
      }
      case 'format-document':
        editorRef.current?.trigger('keyboard', 'editor.action.formatDocument', null);
        break;
      case 'toggle-terminal':
        openConsolePanel('terminal');
        break;
      case 'about':
        pushToast(`${appName} ${version}`, 'info');
        break;
      case 'open-recent-file':
        await openFileWithWorkspace(action.filePath);
        break;
      case 'load-example':
        {
          const nextTab = createUntitledTab(`${action.name}.ino`, action.content);
          setTabs((current) => {
            const nextTabs = [...current, nextTab];
            tabsRef.current = nextTabs;
            return nextTabs;
          });
          activateTab(nextTab);
        }
        break;
    }
  });

  const handleInstallProgress = useEffectEvent((chunk: string) => {
    pushConsole(normalizeOutput(chunk), 'info');
  });

  const handleSelectedBoardChange = useEffectEvent((board: BoardDocument | null) => {
    if (!board) {
      setSelectedBoardSecrets(null);
      setFirmwareHistory([]);
      return;
    }

    void syncBoardSecrets(board.$id);
    void refreshFirmware(board);
  });

  const initializeWorkspace = useEffectEvent(async () => {
    const workspaceResult = await window.tantalum.fs.getLastWorkspace();
    if (workspaceResult.success) {
      await openWorkspace(workspaceResult.path);
    }

    void refreshBoardsList();
    void refreshInstalledLibraries();
    void refreshInstalledPlatforms();
    void refreshDefaultLibraries();
    void refreshDefaultPlatforms();
    void refreshProjectFolders();
  });

  function handleTreeDeleted(targetPath: string, type: FileTreeItemType, skipBroadcast?: boolean) {
    if (skipBroadcast) {
      return;
    }

    closeTabsForPath(targetPath, type);
    pushToast(`Removed ${fileNameFromPath(targetPath)}`, 'info');
    void refreshGitChangeIndicator();
  }

  function handleTreeRenamed(oldPath: string, newPath: string) {
    remapOpenTabs(oldPath, newPath);
    refreshFileTree();
    void refreshGitChangeIndicator();
  }

  function handleTreeFileCreated(createdPath: string, _name: string, savedContent?: string, isUndo?: boolean) {
    if (isUndo && typeof savedContent === 'string') {
      setTabs((current) => {
        if (current.some((tab) => tab.path === createdPath)) {
          return current;
        }

        const nextTabs = [
          ...current,
          createSavedTab(createdPath, savedContent),
        ];
        tabsRef.current = nextTabs;
        return nextTabs;
      });
    }

    refreshFileTree();
    void refreshGitChangeIndicator();
  }

  function handleTreeFolderCreated() {
    refreshFileTree();
    void refreshGitChangeIndicator();
  }

  function handleTreeCopied(newPath: string, type: FileTreeItemType) {
    if (type === 'file') {
      void window.tantalum.fs.addRecentFile(newPath);
    }

    refreshFileTree();
    void refreshGitChangeIndicator();
  }

  function handleTreeMoved() {
    refreshFileTree();
    void refreshGitChangeIndicator();
  }

  function handleTreeError(details: { error: unknown }) {
    const message = details.error instanceof Error ? details.error.message : 'File operation failed.';
    pushToast(message, 'error');
    pushConsole(message, 'error');
  }

  function refreshGitIfPathIsInActiveWorkspace(targetPath: string) {
    if (workspacePath && isPathInsideRoot(targetPath, workspacePath)) {
      void refreshGitChangeIndicator();
    }
  }

  function handleProjectTreeDeleted(targetPath: string, type: FileTreeItemType, skipBroadcast?: boolean) {
    if (skipBroadcast) {
      return;
    }

    closeTabsForPath(targetPath, type);
    refreshProjectTree();
    refreshGitIfPathIsInActiveWorkspace(targetPath);
    void refreshProjectFolders(selectedProjectId);
    pushToast(`Removed ${fileNameFromPath(targetPath)}`, 'info');
  }

  function handleProjectTreeRenamed(oldPath: string, newPath: string) {
    remapOpenTabs(oldPath, newPath);
    refreshProjectTree();
    refreshGitIfPathIsInActiveWorkspace(newPath);
    void refreshProjectFolders(selectedProjectId);
  }

  function handleProjectTreeFileCreated(createdPath: string, _name: string, savedContent?: string, isUndo?: boolean) {
    if (isUndo && typeof savedContent === 'string') {
      setTabs((current) => {
        if (current.some((tab) => tab.path === createdPath)) {
          return current;
        }

        const nextTabs = [...current, createSavedTab(createdPath, savedContent)];
        tabsRef.current = nextTabs;
        return nextTabs;
      });
    }

    refreshProjectTree();
    refreshGitIfPathIsInActiveWorkspace(createdPath);
    void refreshProjectFolders(selectedProjectId);
  }

  function handleProjectTreeFolderCreated(path: string) {
    refreshProjectTree();
    refreshGitIfPathIsInActiveWorkspace(path);
    void refreshProjectFolders(selectedProjectId);
  }

  function handleProjectTreeCopied(newPath: string, type: FileTreeItemType) {
    if (type === 'file') {
      void window.tantalum.fs.addRecentFile(newPath);
    }

    refreshProjectTree();
    refreshGitIfPathIsInActiveWorkspace(newPath);
    void refreshProjectFolders(selectedProjectId);
  }

  function handleProjectTreeMoved() {
    refreshProjectTree();
    if (selectedProject) {
      refreshGitIfPathIsInActiveWorkspace(selectedProject.path);
    }
    void refreshProjectFolders(selectedProjectId);
  }

  function applyAgentFileContent(filePath: string, content: string) {
    const nextName = fileNameFromPath(filePath);

    setTabs((current) => {
      if (!current.some((tab) => isSameFileTabPath(tab.path, filePath))) {
        return current;
      }

      const nextTabs = current.map((tab) => {
        if (!isSameFileTabPath(tab.path, filePath)) {
          return tab;
        }

        return {
          ...tab,
          content,
          savedContent: content,
          isDirty: false,
          name: nextName,
          fileState: 'saved' as FileTabState,
          type: 'file' as const,
          isPreviewFile: false,
        };
      });

      tabsRef.current = nextTabs;
      return nextTabs;
    });

    if (activeTabIdRef.current && isSameFileTabPath(activeTabIdRef.current, filePath)) {
      editorValueRef.current = content;
      setEditorValue(content);
    }
  }

  function handleAgentDeletedPath(targetPath: string, isDirectory: boolean) {
    closeTabsForPath(targetPath, isDirectory ? 'directory' : 'file');
    refreshFileTree();
  }

  const activeExplorerPath = activeTab && !activeTab.path.startsWith('untitled:') ? activeTab.path : null;
  const activeProjectExplorerPath =
    activeExplorerPath && selectedProject?.exists && isPathInsideRoot(activeExplorerPath, selectedProject.path) ? activeExplorerPath : null;
  const currentTerminalFolderPath = activeTab && !activeTab.path.startsWith('untitled:') ? parentPath(activeTab.path) : workspacePath;
  const isTerminalWorkspaceActive = sidebar === 'terminal';
  const renderLegacyLeftTools = false;
  const isConsoleVisible = bottomPanelOpen && !isTerminalWorkspaceActive;
  const leftPanelMax = getPanelMaxSize('left', panelSizes);
  const rightPanelMax = getPanelMaxSize('right', panelSizes);
  const bottomPanelMax = getPanelMaxSize('bottom', panelSizes);
  const workspaceShellStyle = {
    '--left-panel-width': `${panelSizes.left}px`,
    '--right-panel-width': `${panelSizes.right}px`,
  } as CSSProperties;
  const consoleShellStyle = {
    '--console-height': `${panelSizes.bottom}px`,
  } as CSSProperties;

  const handleResizeMove = useEffectEvent((event: PointerEvent) => {
    const activeResize = resizeSessionRef.current;
    if (!activeResize || event.pointerId !== activeResize.pointerId) {
      return;
    }

    event.preventDefault();

    const delta =
      activeResize.panel === 'left'
        ? event.clientX - activeResize.startX
        : activeResize.panel === 'right'
          ? activeResize.startX - event.clientX
          : activeResize.startY - event.clientY;

    setSinglePanelSize(activeResize.panel, activeResize.startSize + delta);
  });

  const stopResizing = useEffectEvent((event?: Event) => {
    const activeResize = resizeSessionRef.current;
    if (!activeResize) {
      return;
    }

    if (event instanceof PointerEvent && event.pointerId !== activeResize.pointerId) {
      return;
    }

    resizeSessionRef.current = null;
    setActiveResizePanel(null);
    document.body.classList.remove('panel-resizing', 'panel-resizing-row', 'panel-resizing-column');
  });

  const clampPanelsToViewport = useEffectEvent(() => {
    applyPanelSizes((current) => normalizePanelSizes(current));
  });

  const handleEditorSaveShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!workspaceActiveRef.current) {
      return;
    }

    const isSaveShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's';
    if (!isSaveShortcut) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void saveActiveTab(event.shiftKey);
  });

  const autoSaveDirtyTabs = useEffectEvent(async () => {
    if (saveInProgressRef.current) {
      return;
    }

    const tabsToSave = tabsRef.current.filter((tab) => !isTemporaryFileTab(tab) && tab.isDirty);
    if (tabsToSave.length === 0) {
      return;
    }

    saveInProgressRef.current = true;
    const savedContentById = new Map<string, string>();
    let shouldRefreshFileTree = false;

    try {
      for (const tabToSave of tabsToSave) {
        const contentToSave = tabToSave.content;
        const writeResult = await window.tantalum.fs.writeFile(tabToSave.path, contentToSave);
        if (!writeResult.success) {
          pushToast(`Auto Save failed for ${tabToSave.name}: ${writeResult.error}`, 'error');
          continue;
        }

        savedContentById.set(tabToSave.id, contentToSave);
        if (workspacePath && isPathInsideRoot(tabToSave.path, workspacePath) && isFirmwareFileName(tabToSave.name)) {
          shouldRefreshFileTree = true;
        }
      }

      if (savedContentById.size === 0) {
        return;
      }

      setTabs((current) => {
        let changed = false;
        const nextTabs = current.map((tab) => {
          const savedContent = savedContentById.get(tab.id);
          if (savedContent === undefined) {
            return tab;
          }

          changed = true;
          return {
            ...tab,
            savedContent,
            isDirty: isTemporaryFileTab(tab) || tab.content !== savedContent,
            isPreviewFile: false,
            fileState: 'saved' as const,
            type: 'file' as const,
          };
        });

        if (!changed) {
          return current;
        }

        tabsRef.current = nextTabs;
        return nextTabs;
      });

      if (shouldRefreshFileTree) {
        refreshFileTree();
      }

      void refreshGitChangeIndicator();
    } finally {
      saveInProgressRef.current = false;
    }
  });

  useEffect(() => {
    panelSizesRef.current = panelSizes;
  }, [panelSizes]);

  useEffect(() => {
    workspaceActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    tabsRef.current = syncedTabs;
  }, [syncedTabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    editorValueRef.current = editorValue;
  }, [editorValue]);

  useEffect(() => {
    if (!active || !uiPreferences.editorAutoSave) {
      return;
    }

    if (!syncedTabs.some((tab) => !isTemporaryFileTab(tab) && tab.isDirty)) {
      return;
    }

    const handle = window.setTimeout(() => {
      void autoSaveDirtyTabs();
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(handle);
    };
  }, [active, syncedTabs, uiPreferences.editorAutoSave]);

  useEffect(() => {
    setActiveTabId((current) => {
      let nextActiveTabId = current;

      if (tabs.length === 0) {
        nextActiveTabId = null;
      } else if (!current || !tabs.some((tab) => tab.id === current)) {
        nextActiveTabId = tabs[0].id;
      }

      activeTabIdRef.current = nextActiveTabId;
      return nextActiveTabId;
    });
  }, [tabs]);

  useEffect(() => {
    if (!activeTab) {
      editorValueRef.current = '';
      setEditorValue('');
      refreshActiveEditorDiagnostics();
      return;
    }

    editorValueRef.current = activeTab.content;
    setEditorValue(activeTab.content);
  }, [activeTab, refreshActiveEditorDiagnostics]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      refreshActiveEditorDiagnostics(activeEditorFilePath);
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [activeEditorFilePath, activeEditorLanguage, refreshActiveEditorDiagnostics]);

  useEffect(() => {
    handleSelectedBoardChange(selectedBoard);
  }, [selectedBoardId, selectedBoard]);

  useEffect(() => {
    if (!autoScrollLogs || !consoleOutputRef.current) {
      return;
    }

    consoleOutputRef.current.scrollTop = consoleOutputRef.current.scrollHeight;
  }, [consoleEntries, autoScrollLogs]);

  useEffect(() => {
    void initializeWorkspace();

    const offMenu = window.tantalum.app.onMenuAction((action) => {
      void handleMenuAction(action);
    });
    const offProgress = window.tantalum.toolchain.onInstallProgress((chunk) => {
      handleInstallProgress(chunk);
    });

    return () => {
      offMenu();
      offProgress();
    };
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleEditorSaveShortcut, true);
    return () => {
      window.removeEventListener('keydown', handleEditorSaveShortcut, true);
    };
  }, []);

  useEffect(() => {
    clampPanelsToViewport();

    window.addEventListener('resize', clampPanelsToViewport);
    return () => {
      window.removeEventListener('resize', clampPanelsToViewport);
    };
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', stopResizing);
    window.addEventListener('pointercancel', stopResizing);
    window.addEventListener('blur', stopResizing);

    return () => {
      window.removeEventListener('pointermove', handleResizeMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
      window.removeEventListener('blur', stopResizing);
      document.body.classList.remove('panel-resizing', 'panel-resizing-row', 'panel-resizing-column');
    };
  }, []);

  useEffect(() => {
    if (sidebar !== 'libraries') {
      return;
    }

    if (!librarySearchTerm) {
      setLibrariesLoading(false);
      setLibrariesError(null);
      return;
    }

    let isCancelled = false;

    async function runSearch() {
      setLibrariesLoading(true);
      setLibrariesError(null);

      try {
        const result = await withManagerTimeout(window.tantalum.toolchain.searchLibraries(librarySearchTerm));
        if (isCancelled) {
          return;
        }

        if (!result) {
          setLibraryResults([]);
          setLibrariesError('Library search is taking too long. Try a narrower query.');
          return;
        }

        if (!result.success) {
          setLibraryResults([]);
          setLibrariesError(result.error);
          pushConsole(result.error, 'error');
          return;
        }

        const nextLibraries = limitManagerResults((result.libraries as LibraryEntry[]) ?? []);

        startTransition(() => {
          setLibraryResults(nextLibraries);
        });
      } catch (error) {
        if (!isCancelled) {
          const message = error instanceof Error ? error.message : 'Unable to search libraries.';
          setLibraryResults([]);
          setLibrariesError(message);
          pushConsole(message, 'error');
        }
      } finally {
        if (!isCancelled) {
          setLibrariesLoading(false);
        }
      }
    }

    void runSearch();

    return () => {
      isCancelled = true;
    };
  }, [sidebar, librarySearchTerm, defaultLibraryResults]);

  useEffect(() => {
    if (sidebar !== 'platforms') {
      return;
    }

    if (!platformSearchTerm) {
      setPlatformsLoading(false);
      setPlatformsError(null);
      return;
    }

    let isCancelled = false;

    async function runSearch() {
      setPlatformsLoading(true);
      setPlatformsError(null);

      try {
        const result = await withManagerTimeout(window.tantalum.toolchain.searchBoardPlatforms(platformSearchTerm));
        if (isCancelled) {
          return;
        }

        if (!result) {
          setPlatformResults([]);
          setPlatformsError('Board core search is taking too long. Try a narrower query.');
          return;
        }

        if (!result.success) {
          setPlatformResults([]);
          setPlatformsError(result.error);
          pushConsole(result.error, 'error');
          return;
        }

        const nextPlatforms = limitManagerResults((result.platforms as BoardPlatform[]) ?? []);

        startTransition(() => {
          setPlatformResults(nextPlatforms);
        });
      } catch (error) {
        if (!isCancelled) {
          const message = error instanceof Error ? error.message : 'Unable to search board cores.';
          setPlatformResults([]);
          setPlatformsError(message);
          pushConsole(message, 'error');
        }
      } finally {
        if (!isCancelled) {
          setPlatformsLoading(false);
        }
      }
    }

    void runSearch();

    return () => {
      isCancelled = true;
    };
  }, [sidebar, platformSearchTerm, defaultPlatformResults]);

  const editorMount: OnMount = (editorInstance, monaco: Monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    configureMonacoFeatures(monaco, uiPreferences.accentColor, editorThemeName);
    editorInstance.updateOptions({
      fontFamily: uiPreferences.editorFontFamily,
      fontSize: uiPreferences.editorFontSize,
      tabSize: uiPreferences.editorTabSize,
      wordWrap: uiPreferences.editorWordWrap,
    });
    updateArduinoCppDiagnostics(monaco, editorInstance.getModel(), activeEditorFilePath);
    editorInstance.focus();
    setEditorReady(true);
  };

  function renderBoardDetails() {
    if (!selectedBoard) {
      return (
        <div className="empty-panel">
          <Cpu size={22} />
          <p>Select a board to view its firmware history, token state, and provisioning options.</p>
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
            <div>
              <dt>Token preview</dt>
              <dd>••••••{selectedBoard.tokenPreview || 'n/a'}</dd>
            </div>
            <div>
              <dt>Local secrets</dt>
              <dd>{selectedBoardSecrets?.apiToken && selectedBoardSecrets?.wifiPassword ? 'Available on this machine' : 'Missing locally'}</dd>
            </div>
          </dl>
          <div className="action-row">
            <button className="secondary-button" type="button" onClick={() => setProvisionModalOpen(true)} disabled={!hasDeviceGatewayFunction()}>
              Provision board
            </button>
            <button className="secondary-button" type="button" onClick={() => void handleRotateBoardToken()} disabled={busyAction === 'rotate-token'}>
              Rotate token
            </button>
            <button className="danger-button" type="button" onClick={() => void handleDeleteBoard()} disabled={busyAction === 'delete-board'}>
              Delete board
            </button>
          </div>
          {!hasDeviceGatewayFunction() ? (
            <div className="inline-banner inline-banner-warning">
              Add `VITE_APPWRITE_DEVICE_GATEWAY_FUNCTION_ID` before provisioning or OTA updates will work.
            </div>
          ) : null}
        </section>

        <section className="detail-card">
          <div className="detail-head">
            <div>
              <h3>Firmware history</h3>
              <p>{firmwareHistory.length} release{firmwareHistory.length === 1 ? '' : 's'}</p>
            </div>
            <button className="primary-button compact" type="button" onClick={() => setReleaseModalOpen(true)}>
              New release
            </button>
          </div>
          <div className="release-list">
            {firmwareHistory.length === 0 ? (
              <div className="empty-panel compact">
                <HardDriveUpload size={20} />
                <p>No firmware uploaded yet.</p>
              </div>
            ) : (
              firmwareHistory.map((firmware) => (
                <article key={firmware.$id} className="release-item">
                  <div>
                    <div className="release-title">
                      <strong>{firmware.version}</strong>
                      {firmware.deployed ? <span className="release-badge">Current</span> : null}
                    </div>
                    <p>{firmware.filename}</p>
                    <small>{formatBytes(firmware.size)} • {new Date(firmware.uploadedAt).toLocaleString()}</small>
                  </div>
                  <div className="release-actions">
                    {!firmware.deployed ? (
                      <button className="secondary-button compact" type="button" onClick={() => void handlePromoteFirmware(firmware)}>
                        Promote
                      </button>
                    ) : null}
                    <button className="danger-button compact" type="button" onClick={() => void handleDeleteFirmware(firmware)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderManagerLoading(message: string) {
    return (
      <div className="manager-state manager-state-loading">
        <LoaderCircle size={16} className="spin" />
        <span>{message}</span>
      </div>
    );
  }

  function renderManagerError(message: string) {
    return (
      <div className="manager-state manager-state-error">
        <span>{message}</span>
      </div>
    );
  }

  function renderManagerInlineLoading(message: string) {
    return (
      <div className="manager-inline-status">
        <LoaderCircle size={14} className="spin" />
        <span>{message}</span>
      </div>
    );
  }

  function renderManagerInlineError(message: string) {
    return <div className="manager-inline-status manager-inline-error">{message}</div>;
  }

  function renderBoardsWorkspace() {
    const hasBoards = boards.length > 0;

    return (
      <section className="tool-workspace manager-workspace board-manager-workspace">
        <div className="manager-page-header">
          <div className="manager-title-block">
            <h2>Devices</h2>
          </div>
          <div className="panel-actions">
            <button className="icon-button" type="button" onClick={() => setBoardModalOpen(true)} title="Add board">
              <Plus size={16} />
            </button>
            <button className="icon-button" type="button" onClick={() => void refreshBoardsList()} title="Refresh boards" disabled={boardsLoading}>
              {boardsLoading ? <LoaderCircle size={16} className="spin" /> : <RefreshCcw size={16} />}
            </button>
          </div>
        </div>
        <div className="panel-content manager-panel-content board-list">
          {boardsLoading && !hasBoards ? renderManagerLoading('Loading boards...') : null}
          {!boardsLoading && boardsError && !hasBoards ? renderManagerError(boardsError) : null}
          {!boardsLoading && !boardsError && !hasBoards ? (
            <div className="manager-state manager-state-empty">
              <Cpu size={22} />
              <span>No boards yet. Add your first device to start provisioning and OTA uploads.</span>
              <button className="primary-button compact" type="button" onClick={() => setBoardModalOpen(true)}>
                Add board
              </button>
            </div>
          ) : null}
          {hasBoards ? (
            <>
              {boardsLoading ? renderManagerInlineLoading('Refreshing boards...') : null}
              {boardsError ? renderManagerInlineError(boardsError) : null}
              {boards.map((board) => {
                const status = calculateBoardStatus(board.lastSeen, board.status);
                return (
                  <button
                    key={board.$id}
                    className={`board-card manager-board-card ${selectedBoardId === board.$id ? 'active' : ''}`}
                    type="button"
                    onClick={() => setSelectedBoardId(board.$id)}
                  >
                    <div className="board-card-head">
                      <strong>{board.name}</strong>
                      <span className={`status-pill status-${status}`}>{status}</span>
                    </div>
                    <p>{board.boardType}</p>
                    <small>Firmware {board.firmwareVersion || '1.0.0'}</small>
                  </button>
                );
              })}
            </>
          ) : null}
        </div>
      </section>
    );
  }

  function renderLibrariesWorkspace() {
    const hasLibraries = visibleLibraryResults.length > 0;
    const loadingMessage = librarySearchTerm ? 'Searching libraries...' : 'Loading libraries...';

    return (
      <section className="tool-workspace manager-workspace library-manager-workspace">
        <div className="manager-page-header">
          <div className="manager-title-block">
            <h2>Library Manager</h2>
          </div>
        </div>
        <div className="search-strip manager-search-strip">
          <Search size={15} />
          <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search Arduino libraries" />
        </div>
        <div className="panel-content manager-panel-content result-list">
          {librariesLoading && !hasLibraries ? renderManagerLoading(loadingMessage) : null}
          {!librariesLoading && librariesError && !hasLibraries ? renderManagerError(librariesError) : null}
          {!librariesLoading && !librariesError && !hasLibraries ? (
            <div className="manager-state manager-state-empty">
              <Library size={22} />
              <span>No libraries found.</span>
            </div>
          ) : null}
          {hasLibraries ? (
            <>
              {librariesLoading ? renderManagerInlineLoading(loadingMessage) : null}
              {librariesError ? renderManagerInlineError(librariesError) : null}
              {visibleLibraryResults.map((library) => {
                const isInstalling = busyAction === `library:${library.name}`;
                return (
                  <article key={library.name} className="result-card manager-result-card">
                    <div className="manager-result-copy">
                      <div className="manager-result-title-row">
                        <strong>{library.name}</strong>
                        {library.installed ? <span className="release-badge">Installed</span> : null}
                      </div>
                      <p>{library.sentence || library.paragraph || library.author || 'Arduino library package'}</p>
                      <div className="manager-result-meta">
                        <span>{library.version || 'latest'}</span>
                        {library.category ? <span>{library.category}</span> : null}
                        {library.author ? <span>{library.author}</span> : null}
                      </div>
                    </div>
                    <button
                      className={`compact manager-result-action ${library.installed ? 'secondary-button' : 'primary-button'}`}
                      type="button"
                      disabled={Boolean(library.installed) || isInstalling}
                      onClick={() => void handleInstallLibrary(library)}
                    >
                      {isInstalling ? <LoaderCircle size={13} className="spin" /> : null}
                      {library.installed ? 'Installed' : isInstalling ? 'Installing' : 'Install'}
                    </button>
                  </article>
                );
              })}
            </>
          ) : null}
        </div>
      </section>
    );
  }

  function renderPlatformsWorkspace() {
    const hasPlatforms = visiblePlatformResults.length > 0;
    const loadingMessage = platformSearchTerm ? 'Searching board cores...' : 'Loading board cores...';

    return (
      <section className="tool-workspace manager-workspace platform-manager-workspace">
        <div className="manager-page-header">
          <div className="manager-title-block">
            <h2>Board Manager</h2>
          </div>
        </div>
        <div className="search-strip manager-search-strip">
          <Search size={15} />
          <input value={platformQuery} onChange={(event) => setPlatformQuery(event.target.value)} placeholder="Search board cores" />
        </div>
        <div className="panel-content manager-panel-content result-list">
          {platformsLoading && !hasPlatforms ? renderManagerLoading(loadingMessage) : null}
          {!platformsLoading && platformsError && !hasPlatforms ? renderManagerError(platformsError) : null}
          {!platformsLoading && !platformsError && !hasPlatforms ? (
            <div className="manager-state manager-state-empty">
              <BookOpen size={22} />
              <span>No board cores found.</span>
            </div>
          ) : null}
          {hasPlatforms ? (
            <>
              {platformsLoading ? renderManagerInlineLoading(loadingMessage) : null}
              {platformsError ? renderManagerInlineError(platformsError) : null}
              {visiblePlatformResults.map((platform) => {
                const isInstalling = busyAction === `platform:${platform.id}`;
                const isRemoving = busyAction === `remove-platform:${platform.id}`;
                return (
                  <article key={platform.id} className="result-card manager-result-card">
                    <div className="manager-result-copy">
                      <div className="manager-result-title-row">
                        <strong>{platform.name}</strong>
                        {platform.installed ? <span className="release-badge">Installed</span> : null}
                      </div>
                      <p>{platform.description || platform.maintainer || 'Board platform package'}</p>
                      <div className="manager-result-meta">
                        <span>{platform.latest || platform.version || 'latest'}</span>
                        {platform.maintainer ? <span>{platform.maintainer}</span> : null}
                        {platform.website ? <span>{platform.website.replace(/^https?:\/\//, '')}</span> : null}
                      </div>
                    </div>
                    {platform.installed ? (
                      <button className="danger-button compact manager-result-action" type="button" onClick={() => void handleRemovePlatform(platform)} disabled={isRemoving}>
                        {isRemoving ? <LoaderCircle size={13} className="spin" /> : null}
                        {isRemoving ? 'Removing' : 'Remove'}
                      </button>
                    ) : (
                      <button className="primary-button compact manager-result-action" type="button" onClick={() => void handleInstallPlatform(platform)} disabled={isInstalling}>
                        {isInstalling ? <LoaderCircle size={13} className="spin" /> : null}
                        {isInstalling ? 'Installing' : 'Install'}
                      </button>
                    )}
                  </article>
                );
              })}
            </>
          ) : null}
        </div>
      </section>
    );
  }

  function renderFileTreeMoreMenu(menuId: 'workspace' | 'project', actions: FileTreeMoreAction[]) {
    const isOpen = fileTreeMoreMenu === menuId;
    const menuActions = actions.map((action) => ({
      ...action,
      onSelect: () => {
        setFileTreeMoreMenu(null);
        action.onSelect();
      },
    }));

    return (
      <div
        className="workspace-tree-more"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFileTreeMoreMenu(null);
          }
        }}
      >
        <button
          aria-expanded={isOpen}
          aria-haspopup="menu"
          aria-label="More file tree actions"
          className={`sft-tree-action-btn workspace-tree-action-btn ${isOpen ? 'active' : ''}`.trim()}
          disabled={actions.length === 0}
          onClick={(event) => {
            event.stopPropagation();
            setFileTreeMoreMenu((current) => (current === menuId ? null : menuId));
          }}
          title="More actions"
          type="button"
        >
          <MoreHorizontal aria-hidden="true" size={14} strokeWidth={1.85} />
        </button>
        {isOpen ? (
          <div className="workspace-tree-more-menu" role="menu" onClick={(event) => event.stopPropagation()}>
            {renderFileTreeMoreMenuItems(menuActions)}
          </div>
        ) : null}
      </div>
    );
  }

  const project = selectedProject;
  const projectCountLabel = `${projectFolders.length} ${projectFolders.length === 1 ? 'project' : 'projects'}`;

  function renderProjectCard(projectEntry: ProjectFolder) {
    const isActive = project?.id === projectEntry.id;
    const projectStats = projectEntry.exists
      ? `${projectEntry.details?.topLevelFolders ?? 0} folders / ${projectEntry.details?.topLevelFiles ?? 0} files`
      : 'Missing folder';
    const projectActivity = projectEntry.lastOpenedAt
      ? `Opened ${formatProjectDate(projectEntry.lastOpenedAt)}`
      : `Added ${formatProjectDate(projectEntry.addedAt)}`;

    return (
      <article className={`my-project-card ${isActive ? 'active' : ''} ${projectEntry.exists ? '' : 'missing'}`} key={projectEntry.id}>
        <button
          className="my-project-card-main"
          type="button"
          onClick={() => setSelectedProjectId(projectEntry.id)}
          onDoubleClick={() => void openProjectWorkspace(projectEntry)}
          title={projectEntry.path}
        >
          <ProjectSystemFolderIcon platform={platform} missing={!projectEntry.exists} />
          <span className="my-project-card-copy">
            <span className="my-project-card-title">
              <strong>{getProjectDisplayName(projectEntry)}</strong>
              {projectEntry.favorite ? <Star size={13} fill="currentColor" /> : null}
            </span>
            <span className="my-project-card-path">{projectEntry.path}</span>
            <span className="my-project-card-meta">
              <span>{projectStats}</span>
              <span>{projectActivity}</span>
            </span>
          </span>
        </button>
        <div className="my-project-card-actions">
          <button className="icon-button" type="button" onClick={() => void renameProjectFolder(projectEntry)} title="Rename project">
            <PencilLine size={15} />
          </button>
          <button
            className={`icon-button ${projectEntry.favorite ? 'active' : ''}`}
            type="button"
            onClick={() => void toggleProjectFavorite(projectEntry)}
            title={projectEntry.favorite ? 'Remove favorite' : 'Favorite project'}
          >
            <Star size={15} fill={projectEntry.favorite ? 'currentColor' : 'none'} />
          </button>
          <button className="icon-button" type="button" onClick={() => void copyProjectPath(projectEntry)} title="Copy path">
            <Copy size={15} />
          </button>
          <button className="icon-button" type="button" onClick={() => void revealProjectFolder(projectEntry)} disabled={!projectEntry.exists} title="Reveal in File Explorer">
            <ExternalLink size={15} />
          </button>
          <button className="icon-button" type="button" onClick={() => void inspectProjectFolder(projectEntry)} title="Refresh project details">
            <RefreshCcw size={15} />
          </button>
          {projectEntry.exists ? (
            <button className="primary-button compact" type="button" onClick={() => void openProjectWorkspace(projectEntry)}>
              <FolderOpen size={14} />
              Open in workspace
            </button>
          ) : (
            <button className="secondary-button compact" type="button" onClick={() => void locateProjectFolder(projectEntry)}>
              Locate
            </button>
          )}
        </div>
      </article>
    );
  }

  const myProjectsDetailPanel = (
    <section className="my-projects-detail">
      {!project ? (
        <div className="my-projects-detail-empty">
          <FolderOpen size={28} />
          <h2>My Projects</h2>
          <button className="primary-button" type="button" onClick={() => void pickProjectFolder()}>
            <FolderPlus size={16} />
            Add folder
          </button>
        </div>
      ) : (
        <>
          <header className="my-projects-detail-header">
            <div className="my-projects-detail-title">
              <span className={`project-status-dot ${project.exists ? 'project-status-ready' : 'project-status-missing'}`} />
              <div>
                <h2>{getProjectDisplayName(project)}</h2>
                <p title={project.path}>{project.path}</p>
              </div>
            </div>
            <div className="my-projects-detail-summary">
              <span>{project.exists ? 'Folder ready' : 'Folder missing'}</span>
              <span>{project.details?.gitRepository ? 'Git repository' : 'No Git'}</span>
              <span>Opened {formatProjectDate(project.lastOpenedAt)}</span>
            </div>
            <div className="my-projects-detail-controlbar">
              <div className="my-projects-detail-actions" aria-label="Project actions">
                <button className="icon-button" type="button" onClick={() => void renameProjectFolder(project)} title="Rename project">
                  <PencilLine size={16} />
                </button>
                <button
                  className={`icon-button ${project.favorite ? 'active' : ''}`}
                  type="button"
                  onClick={() => void toggleProjectFavorite(project)}
                  title={project.favorite ? 'Remove favorite' : 'Favorite project'}
                >
                  <Star size={16} fill={project.favorite ? 'currentColor' : 'none'} />
                </button>
                <button className="icon-button" type="button" onClick={() => void copyProjectPath(project)} title="Copy path">
                  <Copy size={16} />
                </button>
                <button className="icon-button" type="button" onClick={() => void revealProjectFolder(project)} disabled={!project.exists} title="Reveal in File Explorer">
                  <ExternalLink size={16} />
                </button>
                <button className="icon-button" type="button" onClick={() => void inspectProjectFolder(project)} title="Refresh project details">
                  <RefreshCcw size={16} />
                </button>
                <button
                  className="icon-button danger-icon-button"
                  type="button"
                  onClick={() => void removeProjectFolder(project)}
                  title="Remove from My Projects"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <button className="primary-button compact my-projects-detail-open" type="button" onClick={() => void openProjectWorkspace(project)} disabled={!project.exists}>
              <FolderOpen size={15} />
              Open workspace
            </button>
          </header>

          {!project.exists ? (
            <div className="my-projects-missing-panel">
              <FolderOpen size={26} />
              <h3>Folder missing</h3>
              <p>{project.path}</p>
              <div className="action-row">
                <button className="secondary-button" type="button" onClick={() => void locateProjectFolder(project)}>
                  Locate
                </button>
                <button className="danger-button" type="button" onClick={() => void removeProjectFolder(project)}>
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <FileTree
              fs={selectedProjectFileTreeFs}
              workspaceRoot={project.path}
              className="workspace-tree-panel my-projects-file-tree"
              activeFilePath={activeProjectExplorerPath}
              onOpenFolder={() => void pickProjectFolder()}
              onFileClick={(path) => void openProjectFile(project, path, { preview: true })}
              onFileOpened={(path, _name, isPreview) => void openProjectFile(project, path, { preview: isPreview ?? true })}
              onFileDeleted={handleProjectTreeDeleted}
              onFileRenamed={handleProjectTreeRenamed}
              onFileCreated={handleProjectTreeFileCreated}
              onFolderCreated={handleProjectTreeFolderCreated}
              onFileCopied={handleProjectTreeCopied}
              onFileMoved={handleProjectTreeMoved}
              onError={handleTreeError}
              refreshTrigger={projectTreeRefreshKey}
              headerTitle="Files"
              iconTheme="material"
              contextMenu={{ renderMenu: renderFileTreeContextMenu }}
              portalContainer={typeof document === 'undefined' ? null : document.body}
              footer={
                <div className="workspace-tree-footer" title={project.path}>
                  {project.path}
                </div>
              }
              renderHeader={(headerProps) =>
                renderCompactFileTreeHeader(
                  headerProps,
                  renderFileTreeMoreMenu('project', [
                    {
                      id: 'refresh-project-tree',
                      label: 'Refresh tree',
                      icon: <RefreshCcw aria-hidden="true" size={13} strokeWidth={1.85} />,
                      onSelect: refreshProjectTree,
                    },
                    ...headerProps.actions.filter((action) => action.id !== 'new-file' && action.id !== 'new-folder').map(renderFileTreeHeaderMoreAction),
                  ]),
                )
              }
              showOpenFolderButton={false}
              sidebarPosition="left"
              theme={fileTreeTheme}
            />
          )}
        </>
      )}
    </section>
  );

  const myProjectsWorkspace = (
      <section
        className={`tool-workspace my-projects-workspace ${projectDropActive ? 'my-projects-drop-active' : ''}`}
        onDragLeave={handleProjectDragLeave}
        onDragOver={handleProjectDragOver}
        onDrop={(event) => void handleProjectDrop(event)}
      >
        <aside className="my-projects-browser">
          <div className="my-projects-browser-header">
            <div>
              <h2>My Projects</h2>
              <span>{projectCountLabel}</span>
            </div>
            <button className="icon-button" type="button" onClick={() => void pickProjectFolder()} title="Add project folder">
              <FolderPlus size={16} />
            </button>
          </div>

          <div className="my-projects-filter-row">
            <label className="my-projects-search" title="Search projects">
              <Search size={15} />
              <input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="Search projects" />
            </label>
            <div className="my-projects-filter-actions">
              <select value={projectSortMode} onChange={(event) => setProjectSortMode(event.target.value as ProjectSortMode)} title="Sort projects">
                <option value="recent">Recent</option>
                <option value="name">Name</option>
                <option value="favorites">Favorites</option>
              </select>
              <div className="my-projects-view-toggle" role="group" aria-label="Project view">
                <button
                  className={projectViewMode === 'grid' ? 'active' : ''}
                  type="button"
                  onClick={() => setProjectViewMode('grid')}
                  title="Grid view"
                  aria-label="Grid view"
                  aria-pressed={projectViewMode === 'grid'}
                >
                  <LayoutGrid size={15} />
                </button>
                <button
                  className={projectViewMode === 'list' ? 'active' : ''}
                  type="button"
                  onClick={() => setProjectViewMode('list')}
                  title="List view"
                  aria-label="List view"
                  aria-pressed={projectViewMode === 'list'}
                >
                  <LayoutList size={15} />
                </button>
              </div>
            </div>
          </div>

          <div className={`my-projects-list my-projects-list-${projectViewMode}`}>
            <button className="editor-empty-action-tile my-project-add-card" type="button" onClick={() => void pickProjectFolder()}>
              <FolderPlus size={30} />
              <span>Add project</span>
            </button>
            {visibleProjects.map(renderProjectCard)}
            {projectFolders.length > 0 && visibleProjects.length === 0 ? (
              <div className="my-projects-empty my-projects-empty-inline">
                <Search size={22} />
                <strong>No matches</strong>
              </div>
            ) : null}
          </div>
        </aside>

        {projectDropActive ? <div className="my-projects-drop-overlay">Drop folders to add them</div> : null}
      </section>
  );

  void renderBoardDetails;

  return (
    <div className={`ide-shell ${bottomPanelOpen ? '' : 'ide-shell-console-collapsed'}`}>
      {!hasRequiredCloudConfiguration() ? (
        <div className="inline-banner inline-banner-error">
          Appwrite configuration is incomplete. Add the missing values in `appwrite.config.json` or provide renderer env overrides before using authentication, boards, database documents, or storage uploads.
        </div>
      ) : null}
      {!hasBoardAdminFunction() ? (
        <div className="inline-banner inline-banner-warning">
          `VITE_APPWRITE_BOARD_ADMIN_FUNCTION_ID` is missing. Board registration still works with a client fallback, but token handling is less robust.
        </div>
      ) : null}

      <main
        className={`workspace-shell ${leftPanelOpen ? '' : 'workspace-shell-left-collapsed'} ${
          rightPanelOpen ? '' : 'workspace-shell-agent-collapsed'
        }`}
        style={workspaceShellStyle}
      >
        <aside className={sidebar === 'explorer' || sidebar === 'my-projects' ? 'left-panel left-panel-tree' : 'left-panel'}>
          <nav className="left-nav" aria-label="Workspace navigation">
            <div className="left-nav-primary-row">
              <button className="left-nav-new-sketch-button" type="button" onClick={createNewTab}>
                <Plus size={16} />
                New sketch
              </button>
              <button
                className="left-nav-collapse-button"
                type="button"
                aria-label={leftNavCollapsed ? 'Show page shortcuts' : 'Hide page shortcuts'}
                aria-controls="workspace-left-nav-pages"
                aria-expanded={!leftNavCollapsed}
                onClick={() => setLeftNavCollapsed((current) => !current)}
                title={leftNavCollapsed ? 'Show page shortcuts' : 'Hide page shortcuts'}
              >
                {leftNavCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </button>
            </div>
            <div id="workspace-left-nav-pages" className="left-nav-pages" hidden={leftNavCollapsed}>
              <button className={sidebar === 'explorer' ? 'active' : ''} type="button" onClick={() => setSidebar('explorer')}>
                <FolderOpen size={16} />
                Workspace
              </button>
              <button className={sidebar === 'boards' ? 'active' : ''} type="button" onClick={() => setSidebar('boards')}>
                <Cpu size={16} />
                My Boards
              </button>
              <button className={sidebar === 'my-projects' ? 'active' : ''} type="button" onClick={() => setSidebar('my-projects')}>
                <HardDriveUpload size={16} />
                My Projects
              </button>
              <button className={sidebar === 'terminal' ? 'active' : ''} type="button" onClick={() => setSidebar('terminal')}>
                <TerminalSquare size={16} />
                Terminal
              </button>
              <button
                className={`${sidebar === 'git' ? 'active' : ''} ${gitHasChanges ? 'has-change-marker' : ''}`.trim()}
                type="button"
                onClick={() => setSidebar('git')}
              >
                <GitBranch size={16} />
                <span className="left-nav-label">Git</span>
                {gitHasChanges ? <span className="left-nav-dot" title="Git changes" aria-label="Git changes" /> : null}
              </button>
              <button className={sidebar === 'libraries' ? 'active' : ''} type="button" onClick={() => setSidebar('libraries')}>
                <Library size={16} />
                Libraries
              </button>
              <button className={sidebar === 'platforms' ? 'active' : ''} type="button" onClick={() => setSidebar('platforms')}>
                <BookOpen size={16} />
                Platforms
              </button>
            </div>
          </nav>

          <div className="left-projects">
            {sidebar === 'git' ? (
              <GitSourceControlPanel controller={gitController} />
            ) : (
              <>
                <FileTree
                  fs={workspaceFileTreeFs}
                  workspaceRoot={workspacePath}
                  className="workspace-tree-panel"
                  activeFilePath={activeExplorerPath}
                  onOpenFolder={() => void openFolderPicker()}
                  onFileClick={(path) => void openFile(path, { preview: true })}
                  onFileOpened={(path, _name, isPreview) => void openFile(path, { preview: isPreview ?? true })}
                  onFileDeleted={handleTreeDeleted}
                  onFileRenamed={handleTreeRenamed}
                  onFileCreated={handleTreeFileCreated}
                  onFolderCreated={handleTreeFolderCreated}
                  onFileCopied={handleTreeCopied}
                  onFileMoved={handleTreeMoved}
                  onError={handleTreeError}
                  refreshTrigger={fileTreeRefreshKey}
                  headerTitle={workspacePath ? fileNameFromPath(workspacePath) : 'Explorer'}
                  iconTheme="material"
                  contextMenu={{ renderMenu: renderFileTreeContextMenu }}
                  portalContainer={typeof document === 'undefined' ? null : document.body}
                  footer={
                    workspacePath ? (
                      <div className="workspace-tree-footer" title={workspacePath}>
                        {workspacePath}
                      </div>
                    ) : null
                  }
                  renderHeader={(headerProps) =>
                    renderCompactFileTreeHeader(
                      headerProps,
                      renderFileTreeMoreMenu('workspace', [
                        {
                          id: 'toggle-my-projects',
                          label: currentWorkspaceProject ? 'Remove from My Projects' : 'Add to My Projects',
                          icon: currentWorkspaceProject ? (
                            <BookmarkCheck aria-hidden="true" size={13} strokeWidth={1.85} />
                          ) : (
                            <BookmarkPlus aria-hidden="true" size={13} strokeWidth={1.85} />
                          ),
                          onSelect: () => void addCurrentWorkspaceToProjects(),
                          active: Boolean(currentWorkspaceProject),
                          disabled: !workspacePath || busyAction === 'add-current-project',
                        },
                        {
                          id: 'open-folder',
                          label: 'Open folder',
                          icon: <FolderOpen aria-hidden="true" size={13} strokeWidth={1.85} />,
                          onSelect: () => void openFolderPicker(),
                        },
                        {
                          id: 'refresh-explorer',
                          label: 'Refresh explorer',
                          icon: <RefreshCcw aria-hidden="true" size={13} strokeWidth={1.85} />,
                          onSelect: refreshFileTree,
                        },
                        ...headerProps.actions.filter((action) => action.id !== 'new-file' && action.id !== 'new-folder').map(renderFileTreeHeaderMoreAction),
                      ]),
                    )
                  }
                  showOpenFolderButton
                  openFolderButtonPosition="top"
                  sidebarPosition="left"
                  theme={fileTreeTheme}
                />
              </>
            )}
          </div>

          {renderLegacyLeftTools && sidebar === 'boards' ? (
            <>
              <div className="panel-header">
                <div>
                  <h2>Devices</h2>
                </div>
                <div className="panel-actions">
                  <button className="icon-button" type="button" onClick={() => setBoardModalOpen(true)} title="Add board">
                    <Plus size={16} />
                  </button>
                  <button className="icon-button" type="button" onClick={() => void refreshBoardsList()} title="Refresh boards">
                    <RefreshCcw size={16} />
                  </button>
                </div>
              </div>
              <div className="panel-content board-list" aria-busy={boardsLoading} title={boardsError ?? undefined}>
                {boards.length === 0 ? (
                  <div className="empty-panel">
                    <Cpu size={24} />
                    <p>No boards yet. Add your first device to start provisioning and OTA uploads.</p>
                    <button className="primary-button compact" type="button" onClick={() => setBoardModalOpen(true)}>
                      Add board
                    </button>
                  </div>
                ) : (
                  boards.map((board) => {
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
                        <small>Firmware {board.firmwareVersion || '1.0.0'}</small>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          ) : null}

          {renderLegacyLeftTools && sidebar === 'libraries' ? (
            <>
              <div className="panel-header">
                <div>
                  <h2>Library Manager</h2>
                </div>
              </div>
              <div className="search-strip">
                <Search size={16} />
                <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search Arduino libraries" />
              </div>
              <div className="panel-content result-list" aria-busy={librariesLoading} title={librariesError ?? undefined}>
                {visibleLibraryResults.map((library) => (
                  <article key={library.name} className="result-card manager-result-card">
                    <div className="manager-result-copy">
                      <div className="manager-result-title-row">
                        <strong>{library.name}</strong>
                        {library.installed ? <span className="release-badge">Installed</span> : null}
                      </div>
                      <p>{library.sentence || library.paragraph || library.author || 'Arduino library package'}</p>
                      <div className="manager-result-meta">
                        <span>{library.version || 'latest'}</span>
                        {library.category ? <span>{library.category}</span> : null}
                        {library.author ? <span>{library.author}</span> : null}
                      </div>
                    </div>
                    <button
                      className={`compact manager-result-action ${library.installed ? 'secondary-button' : 'primary-button'}`}
                      type="button"
                      disabled={Boolean(library.installed) || busyAction === `library:${library.name}`}
                      onClick={() => void handleInstallLibrary(library)}
                    >
                      {busyAction === `library:${library.name}` ? <LoaderCircle size={14} className="spin" /> : null}
                      {library.installed ? 'Installed' : 'Install'}
                    </button>
                  </article>
                ))}
              </div>
            </>
          ) : null}

          {renderLegacyLeftTools && sidebar === 'platforms' ? (
            <>
              <div className="panel-header">
                <div>
                  <h2>Board Manager</h2>
                </div>
              </div>
              <div className="search-strip">
                <Search size={16} />
                <input value={platformQuery} onChange={(event) => setPlatformQuery(event.target.value)} placeholder="Search board cores" />
              </div>
              <div className="panel-content result-list" aria-busy={platformsLoading} title={platformsError ?? undefined}>
                {visiblePlatformResults.map((platform) => (
                  <article key={platform.id} className="result-card manager-result-card">
                    <div className="manager-result-copy">
                      <div className="manager-result-title-row">
                        <strong>{platform.name}</strong>
                        {platform.installed ? <span className="release-badge">Installed</span> : null}
                      </div>
                      <p>{platform.description || platform.maintainer || 'Board platform package'}</p>
                      <div className="manager-result-meta">
                        <span>{platform.latest || platform.version || 'latest'}</span>
                        {platform.maintainer ? <span>{platform.maintainer}</span> : null}
                        {platform.website ? <span>{platform.website.replace(/^https?:\/\//, '')}</span> : null}
                      </div>
                    </div>
                    {platform.installed ? (
                      <button
                        className="danger-button compact manager-result-action"
                        type="button"
                        onClick={() => void handleRemovePlatform(platform)}
                        disabled={busyAction === `remove-platform:${platform.id}`}
                      >
                        Remove
                      </button>
                    ) : (
                      <button
                        className="primary-button compact manager-result-action"
                        type="button"
                        onClick={() => void handleInstallPlatform(platform)}
                        disabled={busyAction === `platform:${platform.id}`}
                      >
                        {busyAction === `platform:${platform.id}` ? <LoaderCircle size={14} className="spin" /> : null}
                        Install
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </aside>

        <div
          className={`panel-resizer panel-resizer-vertical panel-resizer-left ${activeResizePanel === 'left' ? 'panel-resizer-active' : ''}`}
          role="separator"
          tabIndex={0}
          aria-label="Resize left panel"
          aria-orientation="vertical"
          aria-valuemin={MIN_PANEL_SIZES.left}
          aria-valuemax={leftPanelMax}
          aria-valuenow={panelSizes.left}
          onDoubleClick={() => resetPanelSize('left')}
          onKeyDown={(event) => handleResizerKeyDown('left', event)}
          onPointerDown={(event) => beginResize('left', event)}
        />

        <div className="terminal-workspace-host">
          <TerminalWorkspace active={isTerminalWorkspaceActive} currentFolderPath={currentTerminalFolderPath} uiPreferences={uiPreferences} />
        </div>

        {sidebar === 'boards' ? renderBoardsWorkspace() : null}

        {renderLegacyLeftTools && sidebar === 'boards' ? (
          <section className="tool-workspace">
            <div className="panel-header">
              <div>
                <h2>Devices</h2>
              </div>
              <div className="panel-actions">
                <button className="icon-button" type="button" onClick={() => setBoardModalOpen(true)} title="Add board">
                  <Plus size={16} />
                </button>
                <button className="icon-button" type="button" onClick={() => void refreshBoardsList()} title="Refresh boards">
                  <RefreshCcw size={16} />
                </button>
              </div>
            </div>
            <div className="panel-content board-list">
              {boards.length === 0 ? (
                <div className="empty-panel">
                  <Cpu size={24} />
                  <p>No boards yet. Add your first device to start provisioning and OTA uploads.</p>
                  <button className="primary-button compact" type="button" onClick={() => setBoardModalOpen(true)}>
                    Add board
                  </button>
                </div>
              ) : (
                boards.map((board) => {
                  const status = calculateBoardStatus(board.lastSeen, board.status);
                  return (
                    <button key={board.$id} className={`board-card ${selectedBoardId === board.$id ? 'active' : ''}`} type="button" onClick={() => setSelectedBoardId(board.$id)}>
                      <div className="board-card-head">
                        <strong>{board.name}</strong>
                        <span className={`status-pill status-${status}`}>{status}</span>
                      </div>
                      <p>{board.boardType}</p>
                      <small>Firmware {board.firmwareVersion || '1.0.0'}</small>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        ) : null}

        {sidebar === 'libraries' ? renderLibrariesWorkspace() : null}

        {renderLegacyLeftTools && sidebar === 'libraries' ? (
          <section className="tool-workspace">
            <div className="panel-header">
              <div>
                <h2>Library Manager</h2>
              </div>
            </div>
            <div className="search-strip">
              <Search size={16} />
              <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search Arduino libraries" />
            </div>
            <div className="panel-content result-list">
              {visibleLibraryResults.map((library) => (
                <article key={library.name} className="result-card manager-result-card">
                  <div className="manager-result-copy">
                    <div className="manager-result-title-row">
                      <strong>{library.name}</strong>
                      {library.installed ? <span className="release-badge">Installed</span> : null}
                    </div>
                    <p>{library.sentence || library.paragraph || library.author || 'Arduino library package'}</p>
                    <div className="manager-result-meta">
                      <span>{library.version || 'latest'}</span>
                      {library.category ? <span>{library.category}</span> : null}
                      {library.author ? <span>{library.author}</span> : null}
                    </div>
                  </div>
                  <button
                    className={`compact manager-result-action ${library.installed ? 'secondary-button' : 'primary-button'}`}
                    type="button"
                    disabled={Boolean(library.installed) || busyAction === `library:${library.name}`}
                    onClick={() => void handleInstallLibrary(library)}
                  >
                    {busyAction === `library:${library.name}` ? <LoaderCircle size={14} className="spin" /> : null}
                    {library.installed ? 'Installed' : 'Install'}
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {sidebar === 'git' ? (
          <GitWorkspace controller={gitController} />
        ) : null}

        {sidebar === 'platforms' ? renderPlatformsWorkspace() : null}

        {renderLegacyLeftTools && sidebar === 'platforms' ? (
          <section className="tool-workspace">
            <div className="panel-header">
              <div>
                <h2>Board Manager</h2>
              </div>
            </div>
            <div className="search-strip">
              <Search size={16} />
              <input value={platformQuery} onChange={(event) => setPlatformQuery(event.target.value)} placeholder="Search board cores" />
            </div>
            <div className="panel-content result-list">
              {visiblePlatformResults.map((platform) => (
                <article key={platform.id} className="result-card manager-result-card">
                  <div className="manager-result-copy">
                    <div className="manager-result-title-row">
                      <strong>{platform.name}</strong>
                      {platform.installed ? <span className="release-badge">Installed</span> : null}
                    </div>
                    <p>{platform.description || platform.maintainer || 'Board platform package'}</p>
                    <div className="manager-result-meta">
                      <span>{platform.latest || platform.version || 'latest'}</span>
                      {platform.maintainer ? <span>{platform.maintainer}</span> : null}
                      {platform.website ? <span>{platform.website.replace(/^https?:\/\//, '')}</span> : null}
                    </div>
                  </div>
                  {platform.installed ? (
                    <button className="danger-button compact manager-result-action" type="button" onClick={() => void handleRemovePlatform(platform)} disabled={busyAction === `remove-platform:${platform.id}`}>
                      Remove
                    </button>
                  ) : (
                    <button className="primary-button compact manager-result-action" type="button" onClick={() => void handleInstallPlatform(platform)} disabled={busyAction === `platform:${platform.id}`}>
                      {busyAction === `platform:${platform.id}` ? <LoaderCircle size={14} className="spin" /> : null}
                      Install
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {sidebar === 'terminal' ? (
          <section className="tool-workspace tool-workspace-terminal">
            <TerminalWorkspace active currentFolderPath={currentTerminalFolderPath} uiPreferences={uiPreferences} />
          </section>
        ) : null}

        {sidebar === 'my-projects' ? myProjectsWorkspace : null}

        {sidebar === 'explorer' ? (
        <section className="editor-shell">
          {syncedTabs.length > 0 ? (
            <EditorTabs
              tabs={syncedTabs}
              activeTabPath={activeTab?.path ?? null}
              onTabClick={(path) => selectTabByPath(path)}
              onTabClose={(path) => closeTab(path)}
              onTabReorder={handleTabReorder}
            />
          ) : null}
          <div className="editor-stage">
            {activeTab ? (
              <Editor
                height="100%"
                defaultLanguage={activeEditorLanguage}
                language={activeEditorLanguage}
                path={activeEditorPath}
                value={editorValue}
                beforeMount={(monaco) => {
                  configureMonacoFeatures(monaco, uiPreferences.accentColor, editorThemeName);
                }}
                onMount={editorMount}
                    onChange={(nextValue) => {
                      const updated = nextValue ?? '';
                      editorValueRef.current = updated;
                      setEditorValue(updated);
                      updateTabContent(activeTab.path, updated);
                      refreshActiveEditorDiagnostics(activeEditorFilePath);
                    }}
                options={{
                  acceptSuggestionOnCommitCharacter: true,
                  acceptSuggestionOnEnter: 'on',
                  autoClosingBrackets: 'always',
                  autoClosingDelete: 'always',
                  autoClosingOvertype: 'always',
                  autoClosingQuotes: 'always',
                  autoIndent: 'full',
                  automaticLayout: true,
                  bracketPairColorization: { enabled: uiPreferences.editorBracketPairs },
                  codeLens: uiPreferences.editorCodeLens,
                  colorDecorators: true,
                  contextmenu: true,
                  cursorBlinking: 'smooth',
                  detectIndentation: true,
                  dragAndDrop: true,
                  find: { addExtraSpaceOnTop: false },
                  folding: true,
                  foldingHighlight: true,
                  fontFamily: uiPreferences.editorFontFamily,
                  fontSize: uiPreferences.editorFontSize,
                  formatOnPaste: uiPreferences.editorFormatOnPaste,
                  formatOnType: uiPreferences.editorFormatOnType,
                  guides: { bracketPairs: uiPreferences.editorBracketPairs, indentation: true },
                  hover: { enabled: true, sticky: true },
                  inlayHints: { enabled: uiPreferences.editorInlayHints ? 'on' : 'off' },
                  inlineSuggest: { enabled: uiPreferences.editorInlineSuggest },
                  lightbulb: { enabled: 'on' as editor.ShowLightbulbIconMode },
                  lineDecorationsWidth: 12,
                  lineNumbers: uiPreferences.editorLineNumbers,
                  lineNumbersMinChars: 3,
                  links: true,
                  matchBrackets: 'always',
                  minimap: { enabled: uiPreferences.editorMinimap, maxColumn: 42, side: 'right', showSlider: 'mouseover', size: 'proportional' },
                  mouseWheelZoom: true,
                  occurrencesHighlight: 'singleFile',
                  overviewRulerLanes: 3,
                  padding: { top: 18, bottom: 18 },
                  parameterHints: { enabled: true, cycle: true },
                  quickSuggestions: uiPreferences.editorQuickSuggestions ? { comments: true, other: true, strings: true } : false,
                  renderLineHighlight: 'all',
                  renderValidationDecorations: 'on',
                  scrollBeyondLastLine: false,
                  scrollbar: {
                    horizontalScrollbarSize: 6,
                    horizontalSliderSize: 6,
                    useShadows: false,
                    verticalScrollbarSize: 6,
                    verticalSliderSize: 6,
                  },
                  smoothScrolling: true,
                  snippetSuggestions: 'inline',
                  stickyScroll: { enabled: uiPreferences.editorStickyScroll },
                  suggest: {
                    filterGraceful: true,
                    localityBonus: true,
                    preview: true,
                    previewMode: 'prefix',
                    selectionMode: 'always',
                    showClasses: true,
                    showColors: true,
                    showConstants: true,
                    showConstructors: true,
                    showDeprecated: true,
                    showEnumMembers: true,
                    showEnums: true,
                    showEvents: true,
                    showFields: true,
                    showFiles: true,
                    showFolders: true,
                    showFunctions: true,
                    showIcons: true,
                    showInlineDetails: true,
                    showInterfaces: true,
                    showIssues: true,
                    showKeywords: true,
                    showMethods: true,
                    showModules: true,
                    showOperators: true,
                    showProperties: true,
                    showReferences: true,
                    showSnippets: true,
                    showStructs: true,
                    showTypeParameters: true,
                    showUnits: true,
                    showUsers: true,
                    showValues: true,
                    showVariables: true,
                    snippetsPreventQuickSuggestions: false,
                  },
                  suggestOnTriggerCharacters: uiPreferences.editorQuickSuggestions,
                  tabCompletion: 'on',
                  tabSize: uiPreferences.editorTabSize,
                  unicodeHighlight: { ambiguousCharacters: false },
                  wordBasedSuggestions: 'allDocuments',
                  wordBasedSuggestionsOnlySameLanguage: false,
                  wordWrap: uiPreferences.editorWordWrap,
                }}
                theme={editorReady ? editorThemeName : resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
              />
            ) : (
              <div className="editor-empty-state">
                <div className="editor-empty-actions">
                  <button className="editor-empty-action-tile" type="button" onClick={createNewTab}>
                    <Plus size={30} />
                    <span>New sketch</span>
                  </button>
                  <button className="editor-empty-action-tile" type="button" onClick={() => void openFolderPicker()}>
                    <FolderOpen size={30} />
                    <span>Open workspace</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
        ) : null}
        <div
          className={`panel-resizer panel-resizer-vertical panel-resizer-right ${activeResizePanel === 'right' ? 'panel-resizer-active' : ''}`}
          role="separator"
          tabIndex={0}
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemin={MIN_PANEL_SIZES.right}
          aria-valuemax={rightPanelMax}
          aria-valuenow={panelSizes.right}
          onDoubleClick={() => resetPanelSize('right')}
          onKeyDown={(event) => handleResizerKeyDown('right', event)}
          onPointerDown={(event) => beginResize('right', event)}
        />

        <aside className={`right-panel inspector-panel ${sidebar === 'git' ? 'git-graph-panel-host' : sidebar === 'my-projects' ? 'my-projects-panel-host' : 'chat-panel'}`}>
          <div className="inspector-tabs" style={{ display: 'none' }}></div>
          <div className="inspector-body">
            {sidebar === 'git' ? (
              <GitHistoryPanel controller={gitController} />
            ) : sidebar === 'my-projects' ? (
              myProjectsDetailPanel
            ) : (
              <AgentPanel user={user} workspacePath={workspacePath} activeTab={activeTab && !activeTab.path.startsWith('untitled:') ? { path: activeTab.path, name: activeTab.name, content: editorValue, isDirty: Boolean(activeTab.isDirty) } : null} onFileContentApplied={applyAgentFileContent} onPathDeleted={handleAgentDeletedPath} onRefreshWorkspace={refreshFileTree} pushConsole={pushConsole} pushToast={pushToast} defaultView="chat" chatOnly={true} onOpenSettings={onOpenSettings} onSignedOut={onSignedOut} />
            )}
          </div>
        </aside>
      </main>

      <WorkspaceSearchPopup
        open={workspaceSearchOpen}
        workspacePath={workspacePath}
        dirtyFilePaths={dirtyWorkspaceFilePaths}
        onClose={() => onWorkspaceSearchOpenChange(false)}
        onOpenResult={openWorkspaceSearchResult}
        onReplaceApplied={applyWorkspaceReplaceChanges}
        onNotify={pushToast}
      />

      {isConsoleVisible ? (
        <div
          className={`panel-resizer panel-resizer-horizontal panel-resizer-bottom ${activeResizePanel === 'bottom' ? 'panel-resizer-active' : ''}`}
          role="separator"
          tabIndex={0}
          aria-label="Resize bottom panel"
          aria-orientation="horizontal"
          aria-valuemin={MIN_PANEL_SIZES.bottom}
          aria-valuemax={bottomPanelMax}
          aria-valuenow={panelSizes.bottom}
          onDoubleClick={() => resetPanelSize('bottom')}
          onKeyDown={(event) => handleResizerKeyDown('bottom', event)}
          onPointerDown={(event) => beginResize('bottom', event)}
        />
      ) : null}

      <section className={`console-shell ${isConsoleVisible ? '' : 'console-shell-collapsed'}`} style={consoleShellStyle}>
        <div className="console-header">
          <div className="console-tabs">
            <button className={consoleView === 'output' ? 'active' : ''} type="button" onClick={() => openConsolePanel('output')}>
              Output
            </button>
            <button className={consoleView === 'terminal' ? 'active' : ''} type="button" onClick={() => openConsolePanel('terminal')}>
              Terminal
            </button>
          </div>
          <div className="console-actions">
            <button
              className={`ghost-button compact ${autoScrollLogs ? 'active' : ''}`}
              type="button"
              onClick={() => setAutoScrollLogs((current) => !current)}
              title="Toggle output auto scroll"
            >
              Auto-scroll
            </button>
            <button className="icon-button" type="button" onClick={() => setConsoleEntries([])} title="Clear console">
              <Trash2 size={16} />
            </button>
            <button className="icon-button console-collapse-button" type="button" onClick={toggleConsolePanel} title="Minimize bottom panel">
              <ChevronDown size={16} />
            </button>
          </div>
        </div>
        {!isConsoleVisible ? null : (
          <div ref={consoleOutputRef} className={`console-output console-pane ${consoleView === 'output' ? 'console-pane-active' : 'console-pane-hidden'}`}>
            {consoleEntries.map((entry) => (
              <div key={entry.id} className={`console-line console-${entry.level}`}>
                {entry.message}
              </div>
            ))}
          </div>
        )}
        <ConsoleTerminal active={isConsoleVisible && consoleView === 'terminal'} currentFolderPath={currentTerminalFolderPath} uiPreferences={uiPreferences} />
      </section>

      <footer className="statusbar">
        <span>{workspacePath ? workspacePath : 'No workspace open'}</span>
        <div className="statusbar-actions">
          {!isConsoleVisible && !isTerminalWorkspaceActive ? (
            <button className="ghost-button compact statusbar-console-toggle" type="button" onClick={() => openConsolePanel(consoleView)} title={`Restore ${consoleView} panel`}>
              <ChevronUp size={14} />
              Open {consoleView}
            </button>
          ) : null}
          <span>{selectedBoard ? `${selectedBoard.name} • ${selectedBoard.firmwareVersion || '1.0.0'}` : 'No board selected'}</span>
        </div>
      </footer>

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

      <Modal
        open={provisionModalOpen}
        title="Provision board"
        subtitle="Flash the OTA bootstrap firmware over USB."
        onClose={() => setProvisionModalOpen(false)}
      >
        <div className="modal-form">
          <label>
            Board
            <select value={selectedBoardId} onChange={(event) => setSelectedBoardId(event.target.value)}>
              <option value="">Select board</option>
              {boards.map((board) => (
                <option key={board.$id} value={board.$id}>
                  {board.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            USB port
            <div className="compound-row">
              <select value={selectedProvisionPort} onChange={(event) => setSelectedProvisionPort(event.target.value)}>
                <option value="">Select port</option>
                {provisionPorts.map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.path} • {port.manufacturer}
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                type="button"
                onClick={() =>
                  void window.tantalum.toolchain.listPorts().then((result) => {
                    if (result.success) {
                      setProvisionPorts(result.ports);
                    } else {
                      pushToast(result.error, 'error');
                    }
                  })
                }
              >
                <RefreshCcw size={16} />
              </button>
            </div>
          </label>
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={() => setProvisionModalOpen(false)}>
              Cancel
            </button>
            <button className="primary-button" type="button" onClick={() => void handleProvisionBoard()} disabled={busyAction === 'provision'}>
              {busyAction === 'provision' ? 'Flashing...' : 'Flash firmware'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={releaseModalOpen} title="Create firmware release" subtitle="Compile the current sketch and upload it to Appwrite storage." onClose={() => setReleaseModalOpen(false)}>
        <div className="modal-form">
          <label>
            Target board
            <select value={selectedBoardId} onChange={(event) => setSelectedBoardId(event.target.value)}>
              <option value="">Select board</option>
              {boards.map((board) => (
                <option key={board.$id} value={board.$id}>
                  {board.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version
            <input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="1.0.1" />
          </label>
          <label>
            Release notes
            <textarea value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} placeholder="Optional notes for this firmware release." rows={4} />
          </label>
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={() => setReleaseModalOpen(false)}>
              Cancel
            </button>
            <button className="primary-button" type="button" onClick={() => void handleUploadRelease()} disabled={busyAction === 'upload'}>
              {busyAction === 'upload' ? 'Uploading...' : 'Upload release'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(projectRenamePrompt)}
        title="Rename project"
        subtitle="Change the name shown in My Projects."
        size="sm"
        onClose={() => {
          setProjectRenamePrompt(null);
          setProjectRenameValue('');
        }}
      >
        {projectRenamePrompt ? (
          <form className="modal-form" onSubmit={(event) => void submitProjectRename(event)}>
            <label>
              Project name
              <input
                autoFocus
                value={projectRenameValue}
                onChange={(event) => setProjectRenameValue(event.target.value)}
                placeholder={projectRenamePrompt.name}
              />
            </label>
            <div className="form-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setProjectRenamePrompt(null);
                  setProjectRenameValue('');
                }}
                disabled={busyAction === `rename-project:${projectRenamePrompt.id}`}
              >
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={busyAction === `rename-project:${projectRenamePrompt.id}`}>
                {busyAction === `rename-project:${projectRenamePrompt.id}` ? 'Renaming...' : 'Rename'}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(projectRemovalPrompt)}
        title="Remove from My Projects"
        subtitle="The project folder and files stay untouched on disk."
        onClose={() => setProjectRemovalPrompt(null)}
        size="sm"
      >
        {projectRemovalPrompt ? (
          <div className="modal-form confirmation-dialog">
            <div className="confirmation-dialog-body">
              <span className="confirmation-dialog-icon confirmation-dialog-icon-danger">
                <Trash2 aria-hidden="true" size={18} strokeWidth={1.9} />
              </span>
              <div>
                <strong>Remove {getProjectDisplayName(projectRemovalPrompt)}?</strong>
                <p title={projectRemovalPrompt.path}>{projectRemovalPrompt.path}</p>
              </div>
            </div>
            <div className="form-actions">
              <button className="secondary-button" type="button" onClick={() => setProjectRemovalPrompt(null)} disabled={busyAction === `remove-project:${projectRemovalPrompt.id}`}>
                Cancel
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void confirmProjectFolderRemoval()}
                disabled={busyAction === `remove-project:${projectRemovalPrompt.id}`}
              >
                {busyAction === `remove-project:${projectRemovalPrompt.id}` ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
