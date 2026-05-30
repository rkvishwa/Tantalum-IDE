import '@knurdz/jack-file-tree/keyboard-shield';

import { startTransition, useCallback, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react';
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
  type FileTreeContextMenuActionItem,
  type FileTreeContextMenuRenderProps,
  type FileTreeFsAdapter,
  type FileTreeHeaderActionRenderProps,
  type FileTreeHeaderRenderProps,
  type FileTreeIconRenderProps,
  type FileTreeItemType,
  type FileTreeNode,
  type FileTreeTheme,
} from '@knurdz/jack-file-tree';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import {
  BookmarkCheck,
  BookmarkPlus,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Clipboard,
  Copy,
  Cpu,
  ExternalLink,
  FilePlus2,
  FileCode2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  HardDriveUpload,
  LayoutGrid,
  LayoutList,
  Library,
  Link2,
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
  Wifi,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { editor } from 'monaco-editor';

import { createBoard, deleteBoard, listBoards, rotateBoardToken, startBoardProvisioning, updateBoard } from '@/lib/boards';
import { createAgentThreadMessage, truncateAgentThreadMessages, type AgentThreadMessage } from '@/lib/agent';
import { buildAgentDiffRows, previewContentForAgentChange } from '@/lib/agentDiff';
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
import { getMaterialFileIconUrl, getMaterialFolderIconUrl } from '@/lib/materialFileIcons';
import type {
  FileTreeNativeContextMenuRequest,
  GitStatus,
  CompileProgressEvent,
  LibraryInstallProgressEvent,
  LibraryMigrationProgressEvent,
  LocalBoardDetection,
  LocalBoardPort,
  LocalBoardProfile,
  MenuAction,
  ProjectFolder,
  ToolchainNotification,
  ToolchainNotificationInput,
  ToolchainNotificationKind,
  ToolchainNotificationMetadata,
  ToolchainSketchSource,
  StorageUploadProgressEvent,
  UsbUploadProgressEvent,
  WorkspaceReplaceChangedFile,
  WorkspaceSearchResult,
  BoardCodeProgressEvent,
  BoardCodeSnapshotListResult,
  BoardCodeSnapshotSummary,
  BoardCodeSourceSnapshotInput,
  BoardCodeViewResult,
  SourceRestoreMarker,
} from '@/types/electron';
import type { AgentChangePreview, AgentRestoredFile, AgentRestorePointSummary } from '@/types/electron';

import { ConsoleTerminal } from './ConsoleTerminal';
import { AgentPanel, type AgentEditorSelectionContext, type AgentPendingReview, type AgentPreparedReview, type AgentReviewResolutionNotice } from './AgentPanel';
import { GitHistoryPanel, GitSourceControlPanel, GitWorkspace } from './GitWorkspace';
import { SerialMonitor } from './SerialMonitor';
import { SerialPortBlockerDialog } from './SerialPortBlockerDialog';
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
  onOpenAgentSettings?: () => void;
  sidebar: SidebarView;
  onSidebarChange: (sidebar: SidebarView) => void;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  onRightPanelOpenChange: (open: boolean) => void;
  bottomPanelOpen: boolean;
  onBottomPanelOpenChange: (open: boolean) => void;
  onWorkspaceTitleChange?: (title: string) => void;
  workspaceSearchOpen: boolean;
  onWorkspaceSearchOpenChange: (open: boolean) => void;
  uiPreferences: UiPreferences;
  resolvedTheme: 'dark' | 'light';
  restoreToolchainNotificationRequest?: {
    requestId: number;
    notification: ToolchainNotification;
  } | null;
};

export type SidebarView = 'explorer' | 'boards' | 'libraries' | 'git' | 'platforms' | 'terminal' | 'my-projects';
type ConsoleView = 'output' | 'terminal' | 'serial';
type LibraryManagerTab = 'all' | 'installed';
type LibraryDetailTab = 'overview' | 'versions' | 'examples' | 'dependencies';
type PlatformDetailTab = 'overview' | 'versions';
type FileTabState = 'temporary' | 'preview' | 'saved';
type ProjectSortMode = 'recent' | 'name' | 'favorites';
type ProjectViewMode = 'grid' | 'list';

type AgentPreviewState = {
  reviewId: string;
  changeType: AgentChangePreview['changeType'];
  originalContent: string;
  nextContent: string;
  wasOpen: boolean;
};

type FileTab = EditorTabItem & {
  id: string;
  content: string;
  savedContent: string;
  fileState: FileTabState;
  agentPreview?: AgentPreviewState;
};

type WorkspaceSketchTreeNode = FileTreeNode & {
  sketchSection?: 'included' | 'workspace';
  sectionBoundary?: boolean;
  projectEntry?: boolean;
  lifecycleConflict?: boolean;
};

type ProjectMetadata = {
  schemaVersion: 1;
  entryFile: string;
};

type ProjectIntegrityState = {
  loading: boolean;
  entryFile: string | null;
  lifecycleFiles: string[];
  lifecycleFunctionFiles: string[];
  conflictFiles: string[];
  entryMissing: boolean;
  metadataMissing: boolean;
  error: string | null;
};

type StoredWorkspaceEditorTab = {
  id: string;
  path: string;
  name: string;
  content: string;
  savedContent: string;
  fileState: FileTabState;
  isDirty: boolean;
  isDeleted?: boolean;
  isPreviewFile?: boolean;
  type?: EditorTabItem['type'];
  extension?: string;
  iconKey?: string;
  title?: string;
  agentPreview?: AgentPreviewState;
};

type StoredWorkspaceEditorTabsState = {
  version: 1;
  activeTabId: string | null;
  tabs: StoredWorkspaceEditorTab[];
  updatedAt: string;
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
  detail?: string;
  progress?: number | null;
  progressLabel?: string;
  persistent?: boolean;
  notificationId?: string;
  actions?: Array<{
    label: string;
    onSelect: () => void;
    dismissOnSelect?: boolean;
  }>;
};

type SerialBlockerDialogRequest = {
  port: string;
  title?: string;
  subtitle?: string;
  retryLabel?: string;
  onRetry?: () => void;
};

type BoardPlatform = {
  id: string;
  name: string;
  latest?: string;
  version?: string;
  versions?: string[];
  installedVersion?: string;
  maintainer?: string;
  description?: string;
  website?: string;
  installed?: boolean;
};

type PlatformInstallProgressTask = {
  installId: string;
  platformId: string;
  name: string;
  operation: 'install' | 'remove';
  notificationKind: ToolchainNotificationKind;
  toastId: number;
  version?: string;
  progress: number | null;
  stopping?: boolean;
};

type UsbUploadProgressTask = {
  uploadId: string;
  toastId: number;
  notificationId: string;
  lineBuffer: string;
  lastProgress: number | null;
  notificationKind: ToolchainNotificationKind | string;
  notificationTitle: string;
  notificationName: string;
  notificationTarget: string;
  notificationPhase: string;
  notificationVersion?: string;
  notificationMetadata: ToolchainNotificationMetadata;
  progressMode: 'usb-upload' | 'cloud-runtime-install';
};

type FirmwareReleaseProgressPhase = 'prepare' | 'dependencies' | 'compile' | 'checksum' | 'storage' | 'queue' | 'complete';

type FirmwareReleaseProgressTask = {
  notificationId: string;
  toastId: number;
  boardName: string;
  boardId: string;
  boardType: string;
  version: string;
  filename?: string;
  startedAt: number;
  phaseStartedAt: number;
  phase: FirmwareReleaseProgressPhase;
  detail: string;
  progress: number;
  compileEventCount: number;
  uploadProgressId: string;
  timerId: number | null;
};

type LibraryDependency = string | {
  name?: string;
  version?: string;
  version_constraint?: string;
  versionConstraint?: string;
};

type LibraryExample = {
  name: string;
  relativePath?: string;
  sketchPath?: string;
};

type LibraryReleaseSummary = {
  version: string;
  archiveFileName?: string;
  downloadSize?: number;
  resourceUrl?: string;
  checksum?: string;
  dependencies?: LibraryDependency[];
};

type LibraryEntry = {
  name: string;
  version?: string;
  versions?: string[];
  sentence?: string;
  paragraph?: string;
  author?: string;
  maintainer?: string;
  category?: string;
  architecture?: string;
  architectures?: string[];
  types?: string[];
  license?: string;
  website?: string;
  installedVersion?: string;
  dependencies?: LibraryDependency[];
  resources?: {
    url?: string;
    archive_filename?: string;
    size?: number;
    cache_path?: string;
  };
  resourceUrl?: string;
  archiveFileName?: string;
  downloadSize?: number;
  releases?: LibraryReleaseSummary[];
  examples?: LibraryExample[];
  installDir?: string;
  sourceDir?: string;
  installed?: boolean;
};

const DEFAULT_MANAGER_RESULT_LIMIT = 20;
const MANAGER_LOAD_TIMEOUT_MS = 20000;
const EDITOR_TAB_WHEEL_LINE_DELTA = 1;
const EDITOR_TAB_WHEEL_PAGE_DELTA = 2;
const EDITOR_TAB_SCROLL_MARGIN = 8;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g');

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

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizePackageKey(value: string) {
  return value.trim().toLowerCase();
}

function createToolchainTaskId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getBoardOptionLabel(fqbn: string) {
  return BOARD_OPTIONS.find((option) => option.value === fqbn)?.label ?? fqbn;
}

function isNonUploadableBoardFqbn(fqbn: string | null | undefined) {
  const normalized = String(fqbn || '').trim().toLowerCase();
  return normalized === 'esp32:esp32:esp32_family' || normalized.endsWith(':esp32_family') || normalized.endsWith('_family');
}

function isUploadableBoardFqbn(fqbn: string | null | undefined) {
  return Boolean(String(fqbn || '').trim()) && !isNonUploadableBoardFqbn(fqbn);
}

function isCloudCapableBoardFqbn(fqbn: string | null | undefined) {
  const normalized = String(fqbn || '').trim().toLowerCase();
  return normalized.startsWith('esp32:') || normalized.startsWith('esp8266:');
}

function isOfficialArduinoBoardFqbn(fqbn: string | null | undefined) {
  return String(fqbn || '').trim().toLowerCase().startsWith('arduino:');
}

function normalizeUploadableBoardFqbn(fqbn: string | null | undefined) {
  const normalized = String(fqbn || '').trim();
  return isUploadableBoardFqbn(normalized) ? normalized : '';
}

function firstUploadableBoardFqbn(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = normalizeUploadableBoardFqbn(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function normalizeBoardOptionFromCatalog(entry: Record<string, unknown>): LocalBoardOption | null {
  const value = String(entry.fqbn || entry.FQBN || '').trim();
  if (!isUploadableBoardFqbn(value)) {
    return null;
  }

  const label = String(entry.name || entry.label || value).trim() || value;
  return { value, label };
}

function uniqueBoardOptions(options: LocalBoardOption[]) {
  const optionMap = new Map<string, LocalBoardOption>();
  for (const option of options) {
    if (option.value && !optionMap.has(option.value)) {
      optionMap.set(option.value, option);
    }
  }

  return Array.from(optionMap.values());
}

function boardOptionMatchesQuery(option: LocalBoardOption, query: string) {
  if (!query) {
    return true;
  }

  const normalized = query.toLowerCase();
  return option.label.toLowerCase().includes(normalized) || option.value.toLowerCase().includes(normalized);
}

function localBoardDisplayName(row: Pick<LocalBoardRow, 'name' | 'boardLabel' | 'fqbn' | 'port'>) {
  return row.name || row.boardLabel || getBoardOptionLabel(row.fqbn) || row.port || 'Local board';
}

function localBoardConfidenceLabel(confidence: number | null | undefined) {
  if (typeof confidence !== 'number') {
    return 'manual';
  }

  if (confidence >= 0.9) {
    return 'high';
  }

  if (confidence >= 0.55) {
    return 'medium';
  }

  return 'low';
}

function localBoardConfidenceText(row: LocalBoardRow) {
  if (row.source === 'manual') {
    return 'Manual';
  }

  const label = row.confidenceLabel || localBoardConfidenceLabel(row.confidence);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} confidence`;
}

function canUploadLocalBoard(row: Pick<LocalBoardRow, 'fqbn' | 'port' | 'connected'> | null | undefined) {
  if (!row || !isUploadableBoardFqbn(row.fqbn) || !row.port) {
    return false;
  }

  return row.connected;
}

function canAttemptLocalUpload(row: Pick<LocalBoardRow, 'fqbn' | 'port'> | null | undefined) {
  return Boolean(row && isUploadableBoardFqbn(row.fqbn) && row.port);
}

function isLocalUploadBusyAction(action: string | null) {
  return action === 'prepare-upload' || action === 'verify-before-upload' || action === 'upload-local';
}

function localBoardPortLabel(port: LocalBoardPort) {
  const descriptor = port.protocolLabel && port.protocolLabel !== port.path ? port.protocolLabel : port.label;
  const details = [descriptor, port.manufacturer && port.manufacturer !== descriptor ? port.manufacturer : '']
    .filter(Boolean)
    .join(' - ');

  return details ? `${port.path} (${details})` : port.path;
}

function compareLocalBoardPorts(left: LocalBoardPort, right: LocalBoardPort) {
  if (Boolean(left.likelyBoard) !== Boolean(right.likelyBoard)) {
    return left.likelyBoard ? -1 : 1;
  }

  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' });
}

function normalizeLocalBoardHardwareValue(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase();
}

function isTrustedLocalBoardFingerprint(value: string | null | undefined) {
  const normalized = normalizeLocalBoardHardwareValue(value);
  return Boolean(normalized && !normalized.startsWith('manual:'));
}

type LocalBoardHardwareIdentity = {
  path?: string | null;
  port?: string | null;
  fingerprint?: string | null;
  vendorId?: string | null;
  productId?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  locationId?: string | null;
};

function localBoardIdentityPort(identity: LocalBoardHardwareIdentity) {
  return identity.port || identity.path || '';
}

function localBoardTrustedIdentityMatches(candidate: LocalBoardHardwareIdentity, row: LocalBoardHardwareIdentity) {
  if (
    isTrustedLocalBoardFingerprint(row.fingerprint) &&
    isTrustedLocalBoardFingerprint(candidate.fingerprint) &&
    normalizeLocalBoardHardwareValue(row.fingerprint) === normalizeLocalBoardHardwareValue(candidate.fingerprint)
  ) {
    return true;
  }

  if (row.serialNumber && candidate.serialNumber && normalizeLocalBoardHardwareValue(row.serialNumber) === normalizeLocalBoardHardwareValue(candidate.serialNumber)) {
    return true;
  }

  if (row.pnpId && candidate.pnpId && normalizeLocalBoardHardwareValue(row.pnpId) === normalizeLocalBoardHardwareValue(candidate.pnpId)) {
    return true;
  }

  if (row.locationId && candidate.locationId && normalizeLocalBoardHardwareValue(row.locationId) === normalizeLocalBoardHardwareValue(candidate.locationId)) {
    return true;
  }

  return false;
}

function localBoardVidPidMatches(candidate: LocalBoardHardwareIdentity, row: LocalBoardHardwareIdentity) {
  return Boolean(
    row.vendorId &&
      row.productId &&
      candidate.vendorId &&
      candidate.productId &&
      normalizeLocalBoardHardwareValue(row.vendorId) === normalizeLocalBoardHardwareValue(candidate.vendorId) &&
      normalizeLocalBoardHardwareValue(row.productId) === normalizeLocalBoardHardwareValue(candidate.productId),
  );
}

function localBoardHardwareMatchScore(candidate: LocalBoardHardwareIdentity, row: LocalBoardHardwareIdentity) {
  if (
    isTrustedLocalBoardFingerprint(row.fingerprint) &&
    isTrustedLocalBoardFingerprint(candidate.fingerprint) &&
    normalizeLocalBoardHardwareValue(row.fingerprint) === normalizeLocalBoardHardwareValue(candidate.fingerprint)
  ) {
    return 100;
  }

  if (row.serialNumber && candidate.serialNumber && normalizeLocalBoardHardwareValue(row.serialNumber) === normalizeLocalBoardHardwareValue(candidate.serialNumber)) {
    return 85;
  }

  if (row.pnpId && candidate.pnpId && normalizeLocalBoardHardwareValue(row.pnpId) === normalizeLocalBoardHardwareValue(candidate.pnpId)) {
    return 75;
  }

  if (row.locationId && candidate.locationId && normalizeLocalBoardHardwareValue(row.locationId) === normalizeLocalBoardHardwareValue(candidate.locationId)) {
    return 65;
  }

  const rowPort = normalizeLocalBoardHardwareValue(localBoardIdentityPort(row));
  const candidatePort = normalizeLocalBoardHardwareValue(localBoardIdentityPort(candidate));
  if (rowPort && candidatePort && rowPort === candidatePort) {
    return 55;
  }

  if (localBoardVidPidMatches(candidate, row)) {
    return 35;
  }

  return 0;
}

function pickBestLocalBoardHardwareMatch<T extends LocalBoardHardwareIdentity>(candidates: T[], row: LocalBoardHardwareIdentity, minimumScore = 35) {
  const scored = candidates
    .map((candidate) => ({ candidate, score: localBoardHardwareMatchScore(candidate, row) }))
    .filter((entry) => entry.score >= minimumScore)
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best) {
    return null;
  }

  const next = scored[1];
  if (best.score < 55 && next?.score === best.score) {
    return null;
  }

  return best.candidate;
}

function localBoardPortMatchesProfile(port: LocalBoardPort, profile: LocalBoardHardwareIdentity | null | undefined, selectedPortPath?: string) {
  const portPath = normalizeLocalBoardHardwareValue(port.path);
  if (selectedPortPath && portPath === normalizeLocalBoardHardwareValue(selectedPortPath)) {
    return Boolean(port.likelyBoard);
  }

  if (!port.likelyBoard || !profile) {
    return false;
  }

  if (localBoardTrustedIdentityMatches(port, profile)) {
    return true;
  }

  if (profile.port && portPath === normalizeLocalBoardHardwareValue(profile.port)) {
    return Boolean(port.likelyBoard);
  }

  return Boolean(port.likelyBoard && localBoardVidPidMatches(port, profile));
}

function pickSafeLocalBoardPortMatch(ports: LocalBoardPort[], profile: LocalBoardHardwareIdentity | null | undefined, selectedPortPath?: string) {
  if (!profile) {
    return null;
  }

  const selectedPath = normalizeLocalBoardHardwareValue(selectedPortPath || localBoardIdentityPort(profile));
  const exactPort = selectedPath
    ? ports.find((port) => normalizeLocalBoardHardwareValue(port.path) === selectedPath && Boolean(port.likelyBoard)) ?? null
    : null;
  if (exactPort) {
    return exactPort;
  }

  const trustedPort = ports.find((port) => Boolean(port.likelyBoard) && localBoardTrustedIdentityMatches(port, profile)) ?? null;
  if (trustedPort) {
    return trustedPort;
  }

  const vidPidMatches = ports.filter((port) => Boolean(port.likelyBoard) && localBoardVidPidMatches(port, profile));
  if (vidPidMatches.length === 1) {
    return vidPidMatches[0];
  }

  return pickBestLocalBoardHardwareMatch(ports.filter((port) => port.likelyBoard), profile, 55);
}

function localBoardProfileHasLiveConnection(profile: LocalBoardProfile, boards: LocalBoardDetection[], ports: LocalBoardPort[]) {
  const exactPort = normalizeLocalBoardHardwareValue(profile.port);
  if (exactPort && boards.some((board) => normalizeLocalBoardHardwareValue(board.port) === exactPort)) {
    return true;
  }

  if (pickBestLocalBoardHardwareMatch(boards, profile)) {
    return true;
  }

  if (pickSafeLocalBoardPortMatch(ports, profile, profile.port)) {
    return true;
  }

  return Boolean(pickBestLocalBoardHardwareMatch(ports.filter((port) => port.likelyBoard), profile, 55));
}

function localBoardProfileHasPossibleReconnectPort(profile: LocalBoardHardwareIdentity, ports: LocalBoardPort[]) {
  const exactPort = normalizeLocalBoardHardwareValue(profile.port);
  return ports.some((port) => {
    const portPath = normalizeLocalBoardHardwareValue(port.path);
    return (
      (exactPort && portPath === exactPort) ||
      localBoardTrustedIdentityMatches(port, profile) ||
      localBoardVidPidMatches(port, profile) ||
      Boolean(port.likelyBoard)
    );
  });
}

function shouldRunLocalBoardReconnectScan(profiles: LocalBoardProfile[], boards: LocalBoardDetection[], ports: LocalBoardPort[]) {
  if (profiles.length === 0 || ports.length === 0) {
    return false;
  }

  return profiles.some((profile) => {
    return !localBoardProfileHasLiveConnection(profile, boards, ports) && localBoardProfileHasPossibleReconnectPort(profile, ports);
  });
}

function localBoardPortSetSignature(ports: LocalBoardPort[]) {
  return ports
    .map((port) => [
      port.path,
      port.likelyBoard ? 'board' : 'generic',
      port.vendorId,
      port.productId,
      port.serialNumber,
      port.pnpId,
      port.locationId,
    ].map((value) => normalizeLocalBoardHardwareValue(value)).join(':'))
    .sort()
    .join('|');
}

function pickLocalBoardDetectionForUpload(row: LocalBoardRow, detections: LocalBoardDetection[]) {
  const exactPort = normalizeLocalBoardHardwareValue(row.port);
  const exactDetection = exactPort
    ? detections.find((detection) => normalizeLocalBoardHardwareValue(detection.port) === exactPort) ?? null
    : null;
  if (exactDetection) {
    return exactDetection;
  }

  return pickBestLocalBoardHardwareMatch(detections, row);
}

function pickLocalBoardPortForUpload(row: LocalBoardRow, ports: LocalBoardPort[], detection: LocalBoardDetection | null) {
  if (detection?.port) {
    const detectionPath = normalizeLocalBoardHardwareValue(detection.port);
    return ports.find((port) => normalizeLocalBoardHardwareValue(port.path) === detectionPath) ?? portOptionFromBoard(detection);
  }

  const exactPort = normalizeLocalBoardHardwareValue(row.port);
  const exactMatch = exactPort
    ? ports.find((port) => normalizeLocalBoardHardwareValue(port.path) === exactPort && localBoardPortMatchesProfile(port, row, row.port)) ?? null
    : null;
  if (exactMatch) {
    return exactMatch;
  }

  const profileMatch = pickSafeLocalBoardPortMatch(ports, row, row.port);
  if (profileMatch) {
    return profileMatch;
  }

  return pickBestLocalBoardHardwareMatch(ports.filter((port) => port.likelyBoard), row, 55);
}

function isLocalBoardUploadPortUnavailableError(message: string) {
  const normalized = String(message || '');
  return (
    /FileNotFoundError|cannot find the file specified|doesn't exist|not currently available|No such file|ENOENT/i.test(normalized) &&
    !/PermissionError|Access is denied/i.test(normalized)
  );
}

function isLocalBoardUploadRecoverableSerialError(message: string) {
  const normalized = String(message || '');
  return (
    isLocalBoardUploadPortUnavailableError(normalized) ||
    /Cannot configure port|device attached to the system is not functioning|PermissionError|pySerial|port is busy|Access is denied|already open/i.test(normalized)
  );
}

function normalizeToolchainStreamChunk(chunk: string) {
  const ansiEscapePattern = new RegExp(String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`, 'g');
  return String(chunk || '')
    .replace(ansiEscapePattern, '')
    .replace(/\r/g, '\n');
}

function portOptionFromBoard(board: Pick<LocalBoardDetection | LocalBoardProfile, 'port' | 'protocol' | 'protocolLabel' | 'manufacturer' | 'vendorId' | 'productId' | 'serialNumber' | 'pnpId' | 'locationId'>): LocalBoardPort | null {
  if (!board.port) {
    return null;
  }

  return {
    path: board.port,
    label: board.port,
    protocol: board.protocol || 'serial',
    protocolLabel: board.protocolLabel || 'Serial',
    manufacturer: board.manufacturer || 'Unknown',
    vendorId: board.vendorId ?? null,
    productId: board.productId ?? null,
    serialNumber: board.serialNumber ?? null,
    pnpId: board.pnpId ?? null,
    locationId: board.locationId ?? null,
    likelyBoard: true,
  };
}

function getLibraryVersionOptions(library: LibraryEntry) {
  const versions = [library.version, ...(library.versions ?? [])]
    .filter((version): version is string => Boolean(version && version !== 'Unknown'))
    .map((version) => version.trim())
    .filter((version) => version !== 'latest')
    .filter(Boolean);
  const uniqueVersions = Array.from(new Set(versions));
  return ['latest', ...uniqueVersions];
}

function getInstallVersionForPayload(version: string | undefined) {
  if (!version || version === 'latest' || version === 'Unknown') {
    return undefined;
  }

  return version;
}

function normalizeManagerVersion(version: string | null | undefined) {
  const normalized = String(version ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'latest' || normalized.toLowerCase() === 'unknown') {
    return undefined;
  }

  return normalized;
}

function managerVersionsMatch(left: string | undefined, right: string | undefined) {
  if (!left || !right) {
    return false;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }) === 0;
}

function hasLibraryCatalogMetadata(library: LibraryEntry) {
  return (
    (library.versions?.length ?? 0) > 0 ||
    (library.releases?.length ?? 0) > 0 ||
    Boolean(library.resources || library.resourceUrl || library.archiveFileName || library.downloadSize)
  );
}

function getLibraryInstalledVersion(library: LibraryEntry) {
  return normalizeManagerVersion(library.installedVersion ?? (library.installed && !hasLibraryCatalogMetadata(library) ? library.version : undefined));
}

function getLibraryLatestVersion(library: LibraryEntry) {
  const latestVersion = normalizeManagerVersion(library.version);
  if (!latestVersion) {
    return undefined;
  }

  if (library.installed && !hasLibraryCatalogMetadata(library) && managerVersionsMatch(latestVersion, getLibraryInstalledVersion(library))) {
    return undefined;
  }

  return latestVersion;
}

function getLibraryVersionOptionLabel(library: LibraryEntry, version: string) {
  if (version !== 'latest') {
    return version;
  }

  const latestVersion = normalizeManagerVersion(library.version);
  return latestVersion ? `${latestVersion} (Latest)` : 'Latest';
}

function getLibraryDropdownVersionOptions(library: LibraryEntry) {
  const latestVersion = normalizeManagerVersion(library.version);
  return getLibraryVersionOptions(library).filter((version) => (
    version === 'latest' || !managerVersionsMatch(normalizeManagerVersion(version), latestVersion)
  ));
}

function isLibraryOutdated(library: LibraryEntry) {
  const installedVersion = getLibraryInstalledVersion(library);
  const latestVersion = getLibraryLatestVersion(library);
  return Boolean(library.installed && installedVersion && latestVersion && !managerVersionsMatch(installedVersion, latestVersion));
}

function getPlatformInstalledVersion(platform: BoardPlatform) {
  return normalizeManagerVersion(platform.installedVersion ?? (platform.installed ? platform.version : undefined));
}

function getPlatformLatestVersion(platform: BoardPlatform) {
  return normalizeManagerVersion(platform.latest);
}

function getPlatformVersionOptionLabel(platform: BoardPlatform, version: string) {
  if (version !== 'latest') {
    return version;
  }

  const latestVersion = getPlatformLatestVersion(platform);
  return latestVersion ? `${latestVersion} (Latest)` : 'Latest';
}

function getPlatformDropdownVersionOptions(platform: BoardPlatform) {
  const latestVersion = getPlatformLatestVersion(platform);
  return getPlatformVersionOptions(platform).filter((version) => (
    version === 'latest' || !managerVersionsMatch(normalizeManagerVersion(version), latestVersion)
  ));
}

function isPlatformOutdated(platform: BoardPlatform) {
  const installedVersion = getPlatformInstalledVersion(platform);
  const latestVersion = getPlatformLatestVersion(platform);
  return Boolean(platform.installed && installedVersion && latestVersion && !managerVersionsMatch(installedVersion, latestVersion));
}

function applyLibraryInstalledState(libraries: LibraryEntry[], installedLibraries: LibraryEntry[]) {
  const installedByName = new Map(installedLibraries.map((entry) => [normalizePackageKey(entry.name), entry]));
  return libraries.map((library) => ({
    ...library,
    installed: installedByName.has(normalizePackageKey(library.name)),
    installedVersion: installedByName.get(normalizePackageKey(library.name))?.installedVersion ?? installedByName.get(normalizePackageKey(library.name))?.version,
    examples: installedByName.get(normalizePackageKey(library.name))?.examples ?? library.examples,
    installDir: installedByName.get(normalizePackageKey(library.name))?.installDir ?? library.installDir,
    sourceDir: installedByName.get(normalizePackageKey(library.name))?.sourceDir ?? library.sourceDir,
  }));
}

function libraryMatchesSearch(library: LibraryEntry, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return [
    library.name,
    library.version,
    library.installedVersion,
    library.sentence,
    library.paragraph,
    library.author,
    library.maintainer,
    library.category,
  ].some((value) => String(value ?? '').toLowerCase().includes(normalizedQuery));
}

function isGithubLibraryUrl(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

function getLibraryArchitectures(library: LibraryEntry) {
  if (Array.isArray(library.architectures) && library.architectures.length > 0) {
    return library.architectures.join(', ');
  }

  return library.architecture;
}

function getLibraryArchiveFileName(library: LibraryEntry) {
  return library.archiveFileName || library.resources?.archive_filename;
}

function getLibraryDownloadSize(library: LibraryEntry) {
  return library.downloadSize ?? library.resources?.size;
}

function getLibraryDependencyLabel(dependency: LibraryDependency) {
  if (typeof dependency === 'string') {
    return dependency;
  }

  const constraint = dependency.version_constraint || dependency.versionConstraint || dependency.version;
  return [dependency.name, constraint].filter(Boolean).join(' ');
}

function uniqueNonEmpty(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function getLibraryReleases(library: LibraryEntry): LibraryReleaseSummary[] {
  if (library.releases?.length) {
    return library.releases;
  }

  return getLibraryVersionOptions(library)
    .filter((version) => version !== 'latest')
    .map((version) => ({ version }));
}

function getLibraryFeatureHighlights(library: LibraryEntry) {
  const architectures = getLibraryArchitectures(library);
  const dependencyCount = library.dependencies?.length ?? 0;
  const versions = getLibraryReleases(library);

  return uniqueNonEmpty([
    library.sentence,
    library.category ? `${library.category} category package` : undefined,
    architectures ? `Architecture support: ${architectures}` : undefined,
    dependencyCount > 0 ? `${dependencyCount} declared ${dependencyCount === 1 ? 'dependency' : 'dependencies'}` : undefined,
    versions.length > 1 ? `${versions.length} published versions available` : undefined,
    library.website ? `${isGithubLibraryUrl(library.website) ? 'Repository' : 'Official'} link available` : undefined,
  ]).slice(0, 6);
}

function getLibraryUseCases(library: LibraryEntry) {
  const text = [library.name, library.sentence, library.paragraph, library.category].join(' ').toLowerCase();
  const useCases: string[] = [];

  if (/(json|serialization|deserialize|serialize)/.test(text)) {
    useCases.push('Parsing and generating JSON payloads');
  }
  if (/(display|oled|lcd|tft|screen|graphics|gfx)/.test(text)) {
    useCases.push('Building display and screen interfaces');
  }
  if (/(sensor|temperature|humidity|pressure|accelerometer|imu|dht)/.test(text)) {
    useCases.push('Reading sensor data in Projects');
  }
  if (/(led|neopixel|fastled|rgb|addressable)/.test(text)) {
    useCases.push('Controlling LEDs and light animations');
  }
  if (/(mqtt|wifi|ethernet|network|http|client|server|pubsub)/.test(text)) {
    useCases.push('Connecting devices to networks and services');
  }
  if (/(eeprom|flash|storage|filesystem|sd card|memory)/.test(text)) {
    useCases.push('Persisting configuration or device data');
  }
  if (/(i2c|spi|wire|bus|serial|onewire|1-wire)/.test(text)) {
    useCases.push('Communicating with peripherals and buses');
  }
  if (/(servo|motor|pwm|stepper|actuator)/.test(text)) {
    useCases.push('Driving motors, servos, or actuators');
  }

  if (library.category) {
    useCases.push(`${library.category} Projects and prototypes`);
  }

  return uniqueNonEmpty(useCases.length ? useCases : ['Arduino Projects that use this package API']).slice(0, 6);
}

function getPlatformVersionOptions(platform: BoardPlatform) {
  const versions = [platform.latest, platform.version, platform.installedVersion, ...(platform.versions ?? [])]
    .filter((version): version is string => Boolean(version && version !== 'Unknown'))
    .map((version) => version.trim())
    .filter((version) => version !== 'latest')
    .filter(Boolean);
  const uniqueVersions = Array.from(new Set(versions));
  return ['latest', ...uniqueVersions];
}

function getPlatformInstallVersion(platform: BoardPlatform, selectedVersion: string | undefined) {
  if (!selectedVersion || selectedVersion === 'latest' || selectedVersion === 'Unknown') {
    return getPlatformLatestVersion(platform) || normalizeManagerVersion(platform.version) || 'latest';
  }

  return selectedVersion;
}

function extractInstallProgressPercent(chunk: string) {
  const match = String(chunk || '').match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) {
    return null;
  }

  const progress = Number.parseFloat(match[1]);
  if (!Number.isFinite(progress)) {
    return null;
  }

  return Math.max(0, Math.min(100, progress));
}

function formatInstallProgressMessage(chunk: string, fallback: string) {
  const line = String(chunk || '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .pop();

  return line || fallback;
}

function getPlatformSupportedBoards(platform: BoardPlatform) {
  const description = platform.description?.trim();
  const boardsPrefix = 'Boards included in this package:';
  if (description?.startsWith(boardsPrefix)) {
    return description
      .slice(boardsPrefix.length)
      .split(',')
      .map((board) => board.trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  return uniqueNonEmpty([
    description,
    platform.id ? `Core package: ${platform.id}` : undefined,
  ]).slice(0, 4);
}

function getPlatformUseCases(platform: BoardPlatform) {
  const text = [platform.id, platform.name, platform.description, platform.maintainer].join(' ').toLowerCase();
  const useCases: string[] = [];

  if (/(esp32|esp8266|wifi|wireless|iot)/.test(text)) {
    useCases.push('Wireless and IoT device firmware');
  }
  if (/(avr|uno|nano|mega|classic)/.test(text)) {
    useCases.push('Classic Arduino Project builds and uploads');
  }
  if (/(samd|mbed|renesas|portenta|mkr)/.test(text)) {
    useCases.push('Modern Arduino board projects');
  }
  if (/(rp2040|pico)/.test(text)) {
    useCases.push('RP2040 and Pico-compatible Projects');
  }
  if (/(stm32|stmicroelectronics)/.test(text)) {
    useCases.push('STM32 microcontroller development');
  }
  if (/(nrf|nordic|ble|bluetooth)/.test(text)) {
    useCases.push('Bluetooth and low-power device Projects');
  }

  return uniqueNonEmpty(useCases.length ? useCases : [`Compiling and uploading Projects for ${platform.name}`]).slice(0, 5);
}

function applyPlatformInstalledState(platforms: BoardPlatform[], installedPlatforms: BoardPlatform[]) {
  const installedById = new Map(installedPlatforms.map((entry) => [normalizePackageKey(entry.id), entry]));
  return platforms.map((platform) => {
    const installedPlatform = installedById.get(normalizePackageKey(platform.id));

    return {
      ...platform,
      installed: Boolean(installedPlatform),
      installedVersion: installedPlatform?.installedVersion ?? installedPlatform?.version ?? platform.installedVersion,
      latest: platform.latest ?? installedPlatform?.latest,
      version: platform.version ?? installedPlatform?.version,
      maintainer: platform.maintainer ?? installedPlatform?.maintainer,
      description: platform.description ?? installedPlatform?.description,
      website: platform.website ?? installedPlatform?.website,
      versions: platform.versions ?? installedPlatform?.versions,
    };
  });
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
  right: 330,
  bottom: 260,
};

const MANAGER_DETAIL_PANEL_WIDTH = 460;

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
const PLATFORM_DESCRIPTION_COLLAPSED_LINES = 5;
const AUTO_SAVE_DELAY_MS = 1000;
const LOCAL_BOARD_AUTO_REFRESH_MS = 5000;
const LOCAL_BOARD_UPLOAD_SETTLE_MS = 8000;
const REMOTE_BOARD_AUTO_REFRESH_MS = 120000;
const CLOUD_BOARD_HEARTBEAT_POLL_MS = 5000;
const CLOUD_BOARD_HEARTBEAT_TIMEOUT_MS = 90000;
const RIGHT_PANEL_HIDDEN_BREAKPOINT = 1080;
const LEFT_PANEL_HIDDEN_BREAKPOINT = 980;
const EDITOR_PANEL_BACKGROUND = {
  dark: '#171717',
  light: '#f3f3f3',
} as const;
const FIRMWARE_RELEASE_PHASE_CONFIG = {
  prepare: { start: 2, end: 8, durationMs: 3500, fallbackDetail: 'Preparing firmware release...' },
  dependencies: { start: 8, end: 18, durationMs: 15000, fallbackDetail: 'Checking cloud runtime dependencies...' },
  compile: { start: 18, end: 68, durationMs: 55000, fallbackDetail: 'Compiling firmware release...' },
  checksum: { start: 68, end: 72, durationMs: 2500, fallbackDetail: 'Calculating firmware checksum...' },
  storage: { start: 72, end: 90, durationMs: 18000, fallbackDetail: 'Uploading firmware binary to storage...' },
  queue: { start: 90, end: 98, durationMs: 7000, fallbackDetail: 'Queuing OTA deployment...' },
  complete: { start: 100, end: 100, durationMs: 0, fallbackDetail: 'Firmware uploaded and queued for OTA deployment.' },
} satisfies Record<FirmwareReleaseProgressPhase, { start: number; end: number; durationMs: number; fallbackDetail: string }>;
const FIRMWARE_RELEASE_PROGRESS_TICK_MS = 1000;

const BOARD_OPTIONS = [
  { value: 'esp32:esp32:esp32', label: 'ESP32 Dev Module' },
  { value: 'esp32:esp32:esp32c3', label: 'ESP32-C3 Dev Module' },
  { value: 'esp32:esp32:esp32s3', label: 'ESP32-S3 Dev Module' },
  { value: 'esp32:esp32:esp32s2', label: 'ESP32-S2 Dev Module' },
  { value: 'esp8266:esp8266:generic', label: 'ESP8266 Generic' },
  { value: 'arduino:avr:uno', label: 'Arduino Uno' },
  { value: 'arduino:avr:nano', label: 'Arduino Nano' },
  { value: 'arduino:avr:mega', label: 'Arduino Mega' },
];

const CLOUD_BOARD_OPTIONS = BOARD_OPTIONS.filter((option) => option.value.startsWith('esp32:') || option.value.startsWith('esp8266:'));

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function currentTimestampMs() {
  return Date.now();
}

function sanitizeProgressDetail(message: string | null | undefined, fallback: string) {
  const normalized = String(message || fallback).replace(/\s+/g, ' ').trim();
  return normalized.length > 150 ? `${normalized.slice(0, 147)}...` : normalized;
}

function getLatestProgressOutputLine(message: string | null | undefined, fallback: string) {
  const lines = String(message || '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d{1,3}(?:\.\d+)?\s*%$/.test(line));

  return sanitizeProgressDetail(lines.at(-1), fallback);
}

function formatReleaseProgressLabel(progress: number) {
  const roundedProgress = Math.round(clampPercent(progress));
  return `${roundedProgress}%`;
}

function estimateCloudRuntimeInstallProgress(event: UsbUploadProgressEvent, lastProgress: number | null) {
  const rawProgress = typeof event.progress === 'number' ? clampPercent(event.progress) : null;
  const normalized = `${event.message || ''}\n${event.chunk || ''}`.toLowerCase();
  let estimate: number | null = null;

  if (/ensuring|dependency|arduinojson|pubsubclient|libraries folder|resolving|downloading|extracting|verifying/.test(normalized)) {
    estimate = 12;
  }

  if (/generating tantalum cloud runtime sketch/.test(normalized)) {
    estimate = 24;
  }

  if (/uploading tantalum cloud runtime/.test(normalized)) {
    estimate = 32;
  }

  if (rawProgress !== null) {
    estimate = 32 + rawProgress * 0.63;
  } else if (/detecting libraries|generating function prototypes|compil|linking|building/.test(normalized)) {
    estimate = 44;
  } else if (/connecting|writing|upload|hard resetting|leaving/.test(normalized)) {
    estimate = 72;
  }

  if (estimate === null) {
    return lastProgress;
  }

  return clampPercent(Math.max(lastProgress ?? 0, estimate));
}

function getUsbUploadTaskProgress(task: UsbUploadProgressTask, event: UsbUploadProgressEvent) {
  if (task.progressMode === 'cloud-runtime-install') {
    return estimateCloudRuntimeInstallProgress(event, task.lastProgress);
  }

  if (typeof event.progress === 'number') {
    return clampPercent(event.progress);
  }

  return task.lastProgress;
}

function nextTimedFirmwareReleaseProgress(task: FirmwareReleaseProgressTask, now = Date.now()) {
  const config = FIRMWARE_RELEASE_PHASE_CONFIG[task.phase];
  if (task.phase === 'complete') {
    return 100;
  }

  const elapsed = Math.max(0, now - task.phaseStartedAt);
  const phaseRatio = config.durationMs > 0 ? Math.min(0.92, elapsed / config.durationMs) : 1;
  const estimatedProgress = config.start + (config.end - config.start) * phaseRatio;
  return Math.max(task.progress, Math.min(config.end - 0.5, estimatedProgress));
}

function getCompileProgressPhase(message: string): FirmwareReleaseProgressPhase {
  const normalized = message.toLowerCase();
  if (/(download|extract|install|library|dependency|index)/.test(normalized)) {
    return 'dependencies';
  }

  return 'compile';
}

function estimateCompileProgressFromEvent(task: FirmwareReleaseProgressTask, event: CompileProgressEvent) {
  const rawMessage = event.message || event.chunk;
  const phase = getCompileProgressPhase(rawMessage);
  const config = FIRMWARE_RELEASE_PHASE_CONFIG[phase];
  const rawProgress = typeof event.progress === 'number' ? clampPercent(event.progress) : null;
  const eventCountProgress = config.start + Math.min(config.end - config.start - 1, (task.compileEventCount + 1) * (phase === 'dependencies' ? 1.2 : 0.75));
  const mappedProgress = rawProgress === null
    ? eventCountProgress
    : config.start + ((config.end - config.start) * rawProgress) / 100;

  return {
    phase,
    detail: getLatestProgressOutputLine(rawMessage, config.fallbackDetail),
    progress: Math.min(config.end - 0.5, Math.max(task.progress, mappedProgress)),
  };
}

function mapStorageUploadProgress(progress: number) {
  const config = FIRMWARE_RELEASE_PHASE_CONFIG.storage;
  return config.start + ((config.end - config.start) * clampPercent(progress)) / 100;
}

function PlatformDescription({ description }: { description: string }) {
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [description]);

  useEffect(() => {
    const element = descriptionRef.current;
    if (!element || typeof window === 'undefined') {
      return;
    }

    let frameId: number | null = null;

    const measureOverflow = () => {
      const computedStyle = window.getComputedStyle(element);
      const lineHeight = Number.parseFloat(computedStyle.lineHeight);

      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        setCanExpand(false);
        return;
      }

      setCanExpand(element.scrollHeight > lineHeight * PLATFORM_DESCRIPTION_COLLAPSED_LINES + 1);
    };

    const scheduleMeasure = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(measureOverflow);
    };

    measureOverflow();

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(element);

    if (!resizeObserver) {
      window.addEventListener('resize', scheduleMeasure);
    }

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [description]);

  return (
    <div className="platform-detail-description">
      <p ref={descriptionRef} className={expanded ? undefined : 'platform-detail-description-clamped'}>
        {description}
      </p>
      {canExpand ? (
        <button className="platform-detail-read-more" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? 'Show less' : 'Read more'}
        </button>
      ) : null}
    </div>
  );
}

type LocalBoardEdit = {
  name?: string;
  fqbn?: string;
  boardLabel?: string;
  port?: string;
};

type LocalBoardOption = {
  value: string;
  label: string;
};

const SOURCE_SNAPSHOT_EXTENSIONS = new Set([
  '.ino',
  '.pde',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.ipp',
  '.tpp',
  '.s',
  '.asm',
]);
const WORKSPACE_MAIN_SKETCH_FILE = 'main.ino';
const PROJECT_METADATA_DIRECTORY = '.tentalum';
const PROJECT_METADATA_FILE = 'project.json';
const WORKSPACE_COMPILED_ROOT_FILE_EXTENSIONS = new Set(['.ino', '.pde', '.c', '.cc', '.cpp', '.cxx', '.s', '.h', '.hh', '.hpp', '.hxx', '.ipp', '.tpp']);
const WORKSPACE_COMPILED_ROOT_DIRECTORIES = new Set(['src']);
const SOURCE_SNAPSHOT_PROJECT_ROOT_MARKERS = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'appwrite.config.json',
  'electron-builder.json',
]);
const SOURCE_SNAPSHOT_MAX_FILES = 80;
const SOURCE_SNAPSHOT_MAX_FILE_BYTES = 512 * 1024;
const SOURCE_SNAPSHOT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

type LocalBoardRow = {
  key: string;
  profileId?: string;
  profile?: LocalBoardProfile;
  detection?: LocalBoardDetection;
  source: 'saved' | 'detected' | 'manual';
  connected: boolean;
  name: string;
  fqbn: string;
  port: string;
  boardLabel: string;
  manufacturer: string;
  protocol: string;
  protocolLabel: string;
  vendorId?: string | null;
  productId?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  locationId?: string | null;
  fingerprint: string;
  confidence?: number | null;
  confidenceLabel?: string;
  cloudBoardId?: string;
  cloudLinkedAt?: string;
  lastCloudProvisionedAt?: string;
  lastCloudUsbUploadAt?: string;
  sourceCodeVisibility?: 'private' | 'public' | string;
  portChanged?: boolean;
  stalePort?: string;
  detectionSource?: string;
  matchingBoards?: Array<{ name: string; fqbn: string; isHidden?: boolean }>;
  ai?: LocalBoardDetection['ai'];
};

type BoardCodeTarget = {
  label: string;
  board: {
    id?: string;
    name?: string;
    fqbn: string;
    port?: string;
    profileId?: string;
    fingerprint?: string;
    cloudBoardId?: string;
    sourceCodeVisibility?: 'private' | 'public' | string;
  };
};

type BoardCodeSnapshotRequest = {
  target: BoardCodeTarget;
  result: BoardCodeSnapshotListResult | null;
  loading: boolean;
  error: string;
};

type BoardCodeRestoreRequest = {
  target: BoardCodeTarget;
  snapshot: BoardCodeSnapshotSummary;
  markerVerifiedFromFirmware: boolean;
};

type LiveLocalBoardResolution = {
  row: LocalBoardRow;
  previousPort: string;
  portChanged: boolean;
  savedProfile: LocalBoardProfile | null;
};

function normalizeCloudMatchText(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function localBoardCloudMatchScore(row: Pick<LocalBoardRow, 'name' | 'boardLabel' | 'fqbn'>, board: Pick<BoardDocument, '$id' | 'name' | 'boardType' | 'status'>, preferredBoardId = '') {
  if (!isCloudCapableBoardFqbn(row.fqbn) || normalizeCloudMatchText(row.fqbn) !== normalizeCloudMatchText(board.boardType)) {
    return 0;
  }

  let score = 60;
  const localName = normalizeCloudMatchText(localBoardDisplayName({ ...row, port: '' }));
  const cloudName = normalizeCloudMatchText(board.name);
  if (localName && cloudName && localName === cloudName) {
    score += 35;
  } else if (localName && cloudName && (localName.includes(cloudName) || cloudName.includes(localName))) {
    score += 20;
  }

  if (preferredBoardId && board.$id === preferredBoardId) {
    score += 25;
  }

  if (board.status === 'pending') {
    score += 5;
  }

  return score;
}

function findLikelyCloudBoardForLocal(row: Pick<LocalBoardRow, 'name' | 'boardLabel' | 'fqbn'>, boards: BoardDocument[], preferredBoardId = '') {
  const scored = boards
    .map((board) => ({ board, score: localBoardCloudMatchScore(row, board, preferredBoardId) }))
    .filter((entry) => entry.score >= 60)
    .sort((left, right) => right.score - left.score);

  const preferred = scored.find((entry) => entry.board.$id === preferredBoardId);
  if (preferred) {
    return preferred.board;
  }

  if (scored.length === 1) {
    return scored[0].board;
  }

  if (scored[0] && scored[0].score > (scored[1]?.score ?? 0)) {
    return scored[0].board;
  }

  return null;
}

const LOCAL_BOARD_SELECTED_STORAGE_KEY = 'tantalum-local-board-selected:v1';
const EDITOR_BOARD_LOCAL_PREFIX = 'local:';
const EDITOR_BOARD_CLOUD_PREFIX = 'cloud:';

function localBoardProfileKey(profileId: string) {
  return `profile:${profileId}`;
}

function localBoardDetectionUsageKey(detection: Pick<LocalBoardDetection, 'id' | 'fingerprint' | 'port' | 'path'>) {
  return [
    detection.fingerprint || detection.id || '',
    detection.port || detection.path || '',
  ]
    .map((value) => normalizeLocalBoardHardwareValue(value))
    .filter(Boolean)
    .join('|');
}

function localBoardDetectedKey(detection: Pick<LocalBoardDetection, 'id' | 'fingerprint' | 'port' | 'path'>) {
  return `detected:${localBoardDetectionUsageKey(detection) || normalizeLocalBoardHardwareValue(detection.id)}`;
}

function editorLocalBoardValue(profileId: string) {
  return `${EDITOR_BOARD_LOCAL_PREFIX}${profileId}`;
}

function editorCloudBoardValue(boardId: string) {
  return `${EDITOR_BOARD_CLOUD_PREFIX}${boardId}`;
}

function parseEditorBoardValue(value: string) {
  if (value.startsWith(EDITOR_BOARD_LOCAL_PREFIX)) {
    return { kind: 'local' as const, id: value.slice(EDITOR_BOARD_LOCAL_PREFIX.length) };
  }

  if (value.startsWith(EDITOR_BOARD_CLOUD_PREFIX)) {
    return { kind: 'cloud' as const, id: value.slice(EDITOR_BOARD_CLOUD_PREFIX.length) };
  }

  return { kind: 'none' as const, id: '' };
}

function createManualLocalBoardKey() {
  return `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function readStoredSelectedLocalBoardId() {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    return window.localStorage.getItem(LOCAL_BOARD_SELECTED_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredSelectedLocalBoardId(profileId: string) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (!profileId) {
      window.localStorage.removeItem(LOCAL_BOARD_SELECTED_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(LOCAL_BOARD_SELECTED_STORAGE_KEY, profileId);
  } catch {
    // Ignore storage failures; selection can still be inferred from saved profiles.
  }
}

const DEFAULT_TAB_CONTENT = '';
const DEFAULT_PROJECT_ENTRY_CONTENT = `// Start writing firmware in ${new Date().getFullYear()}

void setup() {
  // Put your setup code here.
}

void loop() {
  // Put your main code here.
}
`;

const EMPTY_PROJECT_INTEGRITY: ProjectIntegrityState = {
  loading: false,
  entryFile: null,
  lifecycleFiles: [],
  lifecycleFunctionFiles: [],
  conflictFiles: [],
  entryMissing: false,
  metadataMissing: true,
  error: null,
};

const FILE_TREE_INTERNAL_TRASH_DIR = '.tantalum-file-tree-trash';
const AGENT_LIVE_REVIEW_STORAGE_PREFIX = 'tantalum-agent-live-review:';
const WORKSPACE_EDITOR_TABS_STORAGE_PREFIX = 'tantalum-workspace-editor-tabs:';
const WORKSPACE_EDITOR_TABS_STORAGE_VERSION = 1;

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

function agentLiveReviewStorageKey(workspacePath: string) {
  return `${AGENT_LIVE_REVIEW_STORAGE_PREFIX}${encodeURIComponent(workspacePath)}`;
}

function readStoredAgentReview(workspacePath: string): AgentPendingReview | null {
  try {
    const raw = localStorage.getItem(agentLiveReviewStorageKey(workspacePath));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as AgentPendingReview;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.threadId !== 'string' || !Array.isArray(parsed.files)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeStoredAgentReview(workspacePath: string, review: AgentPendingReview | null) {
  try {
    const key = agentLiveReviewStorageKey(workspacePath);
    if (!review) {
      localStorage.removeItem(key);
      return;
    }

    localStorage.setItem(key, JSON.stringify(review));
  } catch {
    // Persistence is best-effort; the in-memory review state still works.
  }
}

function normalizeWorkspaceEditorStoragePath(workspacePath: string) {
  return workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function workspaceEditorTabsStorageKey(workspacePath: string) {
  return `${WORKSPACE_EDITOR_TABS_STORAGE_PREFIX}${encodeURIComponent(normalizeWorkspaceEditorStoragePath(workspacePath))}`;
}

function areSameWorkspaceEditorStoragePath(leftPath: string, rightPath: string) {
  return normalizeWorkspaceEditorStoragePath(leftPath) === normalizeWorkspaceEditorStoragePath(rightPath);
}

function isStoredTabPathInsideWorkspace(tabPath: string, workspacePath: string) {
  if (tabPath.startsWith('untitled:')) {
    return true;
  }

  const normalizedTabPath = normalizeWorkspaceEditorStoragePath(tabPath);
  const normalizedWorkspacePath = normalizeWorkspaceEditorStoragePath(workspacePath);

  return normalizedTabPath === normalizedWorkspacePath || normalizedTabPath.startsWith(`${normalizedWorkspacePath}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredFileTabState(value: unknown): value is FileTabState {
  return value === 'temporary' || value === 'preview' || value === 'saved';
}

function isStoredEditorTabType(value: unknown): value is NonNullable<EditorTabItem['type']> {
  return value === 'file' || value === 'preview' || value === 'image';
}

function isStoredAgentChangeType(value: unknown): value is AgentChangePreview['changeType'] {
  return value === 'create' || value === 'update' || value === 'delete';
}

function readStoredAgentPreview(value: unknown): AgentPreviewState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.reviewId !== 'string' ||
    !isStoredAgentChangeType(value.changeType) ||
    typeof value.originalContent !== 'string' ||
    typeof value.nextContent !== 'string' ||
    typeof value.wasOpen !== 'boolean'
  ) {
    return undefined;
  }

  return {
    reviewId: value.reviewId,
    changeType: value.changeType,
    originalContent: value.originalContent,
    nextContent: value.nextContent,
    wasOpen: value.wasOpen,
  };
}

function readStoredWorkspaceEditorTab(value: unknown, workspacePath: string): FileTab | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.savedContent !== 'string' ||
    !isStoredFileTabState(value.fileState)
  ) {
    return null;
  }

  if (!isStoredTabPathInsideWorkspace(value.path, workspacePath)) {
    return null;
  }

  return syncFileTabDirtyState({
    id: value.id,
    path: value.path,
    name: value.name,
    content: value.content,
    savedContent: value.savedContent,
    fileState: value.fileState,
    isDirty: typeof value.isDirty === 'boolean' ? value.isDirty : value.fileState === 'temporary' || value.content !== value.savedContent,
    isDeleted: typeof value.isDeleted === 'boolean' ? value.isDeleted : undefined,
    isPreviewFile: typeof value.isPreviewFile === 'boolean' ? value.isPreviewFile : value.fileState === 'preview',
    type: isStoredEditorTabType(value.type) ? value.type : 'file',
    extension: typeof value.extension === 'string' ? value.extension : undefined,
    iconKey: typeof value.iconKey === 'string' ? value.iconKey : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
    agentPreview: readStoredAgentPreview(value.agentPreview),
  });
}

function serializeWorkspaceEditorTab(tab: FileTab): StoredWorkspaceEditorTab {
  const syncedTab = syncFileTabDirtyState(tab);

  return {
    id: syncedTab.id,
    path: syncedTab.path,
    name: syncedTab.name,
    content: syncedTab.content,
    savedContent: syncedTab.savedContent,
    fileState: syncedTab.fileState,
    isDirty: Boolean(syncedTab.isDirty),
    isDeleted: syncedTab.isDeleted,
    isPreviewFile: syncedTab.isPreviewFile,
    type: syncedTab.type,
    extension: syncedTab.extension,
    iconKey: syncedTab.iconKey,
    title: syncedTab.title,
    agentPreview: syncedTab.agentPreview,
  };
}

function readStoredWorkspaceEditorTabs(workspacePath: string) {
  try {
    const raw = localStorage.getItem(workspaceEditorTabsStorageKey(workspacePath));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== WORKSPACE_EDITOR_TABS_STORAGE_VERSION || !Array.isArray(parsed.tabs)) {
      return null;
    }

    const tabs = parsed.tabs
      .map((tab) => readStoredWorkspaceEditorTab(tab, workspacePath))
      .filter((tab): tab is FileTab => Boolean(tab));
    const activeTabId = typeof parsed.activeTabId === 'string' && tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : null;

    return { tabs, activeTabId };
  } catch {
    return null;
  }
}

function writeStoredWorkspaceEditorTabs(workspacePath: string, tabs: FileTab[], activeTabId: string | null) {
  try {
    const storableTabs = tabs
      .map(syncFileTabDirtyState)
      .filter((tab) => isStoredTabPathInsideWorkspace(tab.path, workspacePath));
    const state: StoredWorkspaceEditorTabsState = {
      version: WORKSPACE_EDITOR_TABS_STORAGE_VERSION,
      activeTabId: activeTabId && storableTabs.some((tab) => tab.id === activeTabId) ? activeTabId : null,
      tabs: storableTabs.map(serializeWorkspaceEditorTab),
      updatedAt: new Date().toISOString(),
    };

    localStorage.setItem(workspaceEditorTabsStorageKey(workspacePath), JSON.stringify(state));
  } catch {
    // Tab persistence is best-effort; the active editor state still remains in memory.
  }
}

function stripFileTabAgentPreview(tab: FileTab): FileTab {
  if (!tab.agentPreview) {
    return tab;
  }

  return {
    ...tab,
    agentPreview: undefined,
    isDeleted: false,
  };
}

function sanitizeRestoredEditorTabs(tabs: FileTab[], review: AgentPendingReview | null) {
  if (!review) {
    return tabs.map(stripFileTabAgentPreview);
  }

  return tabs.map((tab) => (tab.agentPreview?.reviewId === review.id ? tab : stripFileTabAgentPreview(tab)));
}

async function validateStoredAgentReview(workspacePath: string, review: AgentPendingReview | null) {
  if (!review) {
    return null;
  }

  for (const change of review.files) {
    const targetPath = joinPath(workspacePath, change.path);
    const current = await window.tantalum.fs.readFile(targetPath);

    if (change.changeType === 'delete') {
      if (current.success) {
        return null;
      }
      continue;
    }

    if (!current.success || current.content !== change.nextContent) {
      return null;
    }
  }

  return review;
}

const FILE_TREE_CONTEXT_MENU_ICONS: Partial<Record<FileTreeContextMenuActionId | string, LucideIcon>> = {
  'new-file': FilePlus2,
  'new-folder': FolderPlus,
  'open-in-file-manager': FolderOpen,
  'make-entry-point': CheckCircle2,
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

function renderFileTreeHeaderExtraActions(actions: FileTreeMoreAction[]) {
  return actions.map((action) => (
    <button
      aria-label={action.label}
      aria-pressed={action.active}
      className={`sft-tree-action-btn workspace-tree-action-btn ${action.active ? 'active' : ''}`.trim()}
      disabled={action.disabled}
      key={action.id}
      onClick={(event) => {
        event.stopPropagation();
        if (action.disabled) {
          return;
        }

        action.onSelect();
      }}
      title={action.label}
      type="button"
    >
      {action.icon}
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
  leadingActions: FileTreeMoreAction[] = [],
) {
  const primaryActions = actions.filter((action) => action.id === 'new-file' || action.id === 'new-folder');

  return (
    <div className={`${className} workspace-tree-header-compact`} title={workspaceRoot ?? title}>
      <span className={titleClassName}>{title}</span>
      <div className={`${actionsClassName} workspace-tree-header-actions`} style={actionsStyle}>
        {renderFileTreeHeaderExtraActions(leadingActions)}
        {renderFileTreeHeaderActions(primaryActions)}
        {moreMenu}
      </div>
    </div>
  );
}

type NativeFileTreeContextMenuRequestState = {
  promise: ReturnType<Window['tantalum']['fileTree']['showContextMenu']>;
  handled: boolean;
};

const nativeFileTreeContextMenuRequests = new Map<string, NativeFileTreeContextMenuRequestState>();

function createNativeFileTreeContextMenuPayload({ groups, position }: FileTreeContextMenuRenderProps) {
  const actionMap = new Map<string, FileTreeContextMenuActionItem>();
  const nativeGroups = groups
    .map((group, groupIndex) =>
      group
        .filter(Boolean)
        .map((action, actionIndex) => {
          const key = `${groupIndex}:${actionIndex}:${action.id}`;
          actionMap.set(key, action);

          return {
            key,
            id: action.id,
            label: action.label,
            shortcut: action.shortcut,
            disabled: action.disabled,
            danger: action.danger,
          };
        }),
    )
    .filter((group) => group.length > 0);

  return {
    actionMap,
    payload: {
      position,
      groups: nativeGroups,
    } satisfies FileTreeNativeContextMenuRequest,
  };
}

function createNativeFileTreeContextMenuRequestKey(payload: FileTreeNativeContextMenuRequest) {
  return JSON.stringify({
    x: Math.round(payload.position.x),
    y: Math.round(payload.position.y),
    groups: payload.groups.map((group) => group.map((action) => [action.key, action.id, action.label, Boolean(action.disabled)])),
  });
}

function getNativeFileTreeContextMenuRequest(payload: FileTreeNativeContextMenuRequest) {
  const key = createNativeFileTreeContextMenuRequestKey(payload);
  const existing = nativeFileTreeContextMenuRequests.get(key);
  if (existing) {
    return existing;
  }

  const request: NativeFileTreeContextMenuRequestState = {
    promise: window.tantalum.fileTree.showContextMenu(payload),
    handled: false,
  };

  nativeFileTreeContextMenuRequests.set(key, request);
  void request.promise.finally(() => {
    window.setTimeout(() => {
      if (nativeFileTreeContextMenuRequests.get(key) === request) {
        nativeFileTreeContextMenuRequests.delete(key);
      }
    }, 0);
  });

  return request;
}

function NativeFileTreeContextMenu(props: FileTreeContextMenuRenderProps) {
  const { actionMap, payload } = useMemo(() => createNativeFileTreeContextMenuPayload(props), [props]);

  useEffect(() => {
    const request = getNativeFileTreeContextMenuRequest(payload);

    void request.promise
      .then(async (result) => {
        if (request.handled) {
          return;
        }

        request.handled = true;
        if (!result.success) {
          props.closeMenu();
          return;
        }

        const selectedAction = result.actionKey ? actionMap.get(result.actionKey) : null;
        if (!selectedAction || selectedAction.disabled) {
          props.closeMenu();
          return;
        }

        try {
          await selectedAction.onSelect();
        } finally {
          props.closeMenu();
        }
      })
      .catch(() => {
        if (!request.handled) {
          request.handled = true;
          props.closeMenu();
        }
      });
  }, [actionMap, payload, props]);

  return null;
}

function renderInlineFileTreeContextMenu({ groups, closeMenu }: FileTreeContextMenuRenderProps) {
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

function renderFileTreeContextMenu(props: FileTreeContextMenuRenderProps) {
  if (typeof window !== 'undefined' && typeof window.tantalum?.fileTree?.showContextMenu === 'function') {
    return <NativeFileTreeContextMenu {...props} />;
  }

  return renderInlineFileTreeContextMenu(props);
}

let untitledTabCounter = 0;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getEditorTabWheelDelta(event: ReactWheelEvent<HTMLElement>, tabBar: HTMLElement) {
  const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;

  if (event.deltaMode === EDITOR_TAB_WHEEL_LINE_DELTA) {
    return rawDelta * 32;
  }

  if (event.deltaMode === EDITOR_TAB_WHEEL_PAGE_DELTA) {
    return rawDelta * tabBar.clientWidth;
  }

  return rawDelta;
}

function handleEditorTabsWheel(event: ReactWheelEvent<HTMLDivElement>) {
  if (event.ctrlKey) {
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  const tabBar = target?.closest<HTMLElement>('.jet-editor-tabs-bar') ?? null;

  if (!tabBar || tabBar.scrollWidth <= tabBar.clientWidth) {
    return;
  }

  const delta = getEditorTabWheelDelta(event, tabBar);

  if (delta === 0) {
    return;
  }

  const maxScrollLeft = tabBar.scrollWidth - tabBar.clientWidth;
  const nextScrollLeft = clamp(tabBar.scrollLeft + delta, 0, maxScrollLeft);

  if (nextScrollLeft === tabBar.scrollLeft) {
    return;
  }

  tabBar.scrollLeft = nextScrollLeft;
  event.preventDefault();
  event.stopPropagation();
}

function scrollActiveEditorTabIntoView(root: HTMLDivElement | null) {
  const tabBar = root?.querySelector<HTMLElement>('.jet-editor-tabs-bar') ?? null;
  const activeTabElement = tabBar?.querySelector<HTMLElement>('.jet-editor-tab[data-active="true"]') ?? null;

  if (!tabBar || !activeTabElement || tabBar.scrollWidth <= tabBar.clientWidth) {
    return;
  }

  const tabBarRect = tabBar.getBoundingClientRect();
  const activeTabRect = activeTabElement.getBoundingClientRect();
  let nextScrollLeft = tabBar.scrollLeft;

  if (activeTabRect.left < tabBarRect.left + EDITOR_TAB_SCROLL_MARGIN) {
    nextScrollLeft -= tabBarRect.left + EDITOR_TAB_SCROLL_MARGIN - activeTabRect.left;
  } else if (activeTabRect.right > tabBarRect.right - EDITOR_TAB_SCROLL_MARGIN) {
    nextScrollLeft += activeTabRect.right - (tabBarRect.right - EDITOR_TAB_SCROLL_MARGIN);
  }

  const maxScrollLeft = tabBar.scrollWidth - tabBar.clientWidth;
  tabBar.scrollLeft = clamp(nextScrollLeft, 0, maxScrollLeft);
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

function createUntitledTab(name = 'untitled.txt', content = DEFAULT_TAB_CONTENT): FileTab {
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
  onOpenAgentSettings,
  sidebar,
  onSidebarChange,
  leftPanelOpen,
  rightPanelOpen,
  onRightPanelOpenChange,
  bottomPanelOpen,
  onBottomPanelOpenChange,
  onWorkspaceTitleChange,
  workspaceSearchOpen,
  onWorkspaceSearchOpenChange,
  uiPreferences,
  resolvedTheme,
  restoreToolchainNotificationRequest,
}: IDEWorkspaceProps) {
  const setSidebar = useCallback((nextSidebar: SidebarView) => onSidebarChange(nextSidebar), [onSidebarChange]);
  const [consoleView, setConsoleView] = useState<ConsoleView>('output');
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(() => normalizePanelSizes(DEFAULT_PANEL_SIZES));
  const [activeResizePanel, setActiveResizePanel] = useState<ResizablePanel | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [projectIntegrity, setProjectIntegrity] = useState<ProjectIntegrityState>(EMPTY_PROJECT_INTEGRITY);
  const [gitHasChanges, setGitHasChanges] = useState(false);
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [activeEditorSelection, setActiveEditorSelection] = useState<AgentEditorSelectionContext | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [pendingAgentReview, setPendingAgentReview] = useState<AgentPendingReview | null>(null);
  const [resolvingAgentReview, setResolvingAgentReview] = useState(false);
  const [agentReviewNotice, setAgentReviewNotice] = useState<AgentReviewResolutionNotice | null>(null);
  const [agentRestorePoints, setAgentRestorePoints] = useState<AgentRestorePointSummary[]>([]);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>(() => [
    { id: Date.now(), level: 'info', message: 'Ready. Open a folder or start writing firmware.' },
  ]);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [serialBlockerDialog, setSerialBlockerDialog] = useState<SerialBlockerDialogRequest | null>(null);
  const [boards, setBoards] = useState<BoardDocument[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(() => hasRequiredCloudConfiguration());
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [localBoardProfiles, setLocalBoardProfiles] = useState<LocalBoardProfile[]>([]);
  const [detectedLocalBoards, setDetectedLocalBoards] = useState<LocalBoardDetection[]>([]);
  const [localBoardPorts, setLocalBoardPorts] = useState<LocalBoardPort[]>([]);
  const [localBoardAutoScanLoading, setLocalBoardAutoScanLoading] = useState(false);
  const [localBoardsError, setLocalBoardsError] = useState<string | null>(null);
  const [localBoardEdits, setLocalBoardEdits] = useState<Record<string, LocalBoardEdit>>({});
  const [manualLocalBoardKeys, setManualLocalBoardKeys] = useState<string[]>([]);
  const [expandedLocalBoardKeys, setExpandedLocalBoardKeys] = useState<Record<string, boolean>>({});
  const [selectedLocalBoardId, setSelectedLocalBoardId] = useState(() => readStoredSelectedLocalBoardId());
  const [editorBoardSelection, setEditorBoardSelection] = useState('');
  const [localBoardCatalog, setLocalBoardCatalog] = useState<LocalBoardOption[]>([]);
  const [localBoardCatalogLoading, setLocalBoardCatalogLoading] = useState(false);
  const [localBoardCatalogError, setLocalBoardCatalogError] = useState<string | null>(null);
  const [localBoardCatalogQuery, setLocalBoardCatalogQuery] = useState('');
  const [localBoardAdvancedOpenKey, setLocalBoardAdvancedOpenKey] = useState<string | null>(null);
  const [selectedBoardSecrets, setSelectedBoardSecrets] = useState<BoardSecret | null>(null);
  const [firmwareHistory, setFirmwareHistory] = useState<FirmwareDocument[]>([]);
  const [boardModalOpen, setBoardModalOpen] = useState(false);
  const [provisionModalOpen, setProvisionModalOpen] = useState(false);
  const [releaseModalOpen, setReleaseModalOpen] = useState(false);
  const [boardCodeSnapshotRequest, setBoardCodeSnapshotRequest] = useState<BoardCodeSnapshotRequest | null>(null);
  const [boardCodeRestoreRequest, setBoardCodeRestoreRequest] = useState<BoardCodeRestoreRequest | null>(null);
  const [boardForm, setBoardForm] = useState<BoardInput>({
    name: '',
    boardType: 'esp32:esp32:esp32',
    sourceCodeVisibility: 'private',
  });
  const [selectedLinkLocalProfileId, setSelectedLinkLocalProfileId] = useState('');
  const [pendingSelectedLocalCloudLink, setPendingSelectedLocalCloudLink] = useState<{ profileId: string; boardId: string } | null>(null);
  const [pendingCloudRuntimeInstall, setPendingCloudRuntimeInstall] = useState<{ profileId: string; boardId: string } | null>(null);
  const [usbWifiModalOpen, setUsbWifiModalOpen] = useState(false);
  const [usbWifiProfileId, setUsbWifiProfileId] = useState('');
  const [usbWifiForm, setUsbWifiForm] = useState({ ssid: '', password: '' });
  const [provisionPorts, setProvisionPorts] = useState<Array<{ path: string; manufacturer: string }>>([]);
  const [selectedProvisionPort, setSelectedProvisionPort] = useState('');
  const [releaseVersion, setReleaseVersion] = useState('1.0.1');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryManagerTab, setLibraryManagerTab] = useState<LibraryManagerTab>('all');
  const [libraryDetailTab, setLibraryDetailTab] = useState<LibraryDetailTab>('overview');
  const [selectedLibraryKey, setSelectedLibraryKey] = useState<string | null>(null);
  const [libraryResults, setLibraryResults] = useState<LibraryEntry[]>([]);
  const [defaultLibraryResults, setDefaultLibraryResults] = useState<LibraryEntry[]>(FALLBACK_LIBRARY_RESULTS);
  const [installedLibraries, setInstalledLibraries] = useState<LibraryEntry[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesError, setLibrariesError] = useState<string | null>(null);
  const [libraryVersionSelections, setLibraryVersionSelections] = useState<Record<string, string>>({});
  const [activeLibraryInstalls, setActiveLibraryInstalls] = useState<Record<string, string>>({});
  const [activePlatformInstalls, setActivePlatformInstalls] = useState<Record<string, string>>({});
  const [stoppingInstallIds, setStoppingInstallIds] = useState<Record<string, boolean>>({});
  const [platformQuery, setPlatformQuery] = useState('');
  const [platformResults, setPlatformResults] = useState<BoardPlatform[]>([]);
  const [defaultPlatformResults, setDefaultPlatformResults] = useState<BoardPlatform[]>(FALLBACK_PLATFORM_RESULTS);
  const [installedPlatforms, setInstalledPlatforms] = useState<BoardPlatform[]>([]);
  const [platformsLoading, setPlatformsLoading] = useState(false);
  const [platformsError, setPlatformsError] = useState<string | null>(null);
  const [platformDetailTab, setPlatformDetailTab] = useState<PlatformDetailTab>('overview');
  const [selectedPlatformKey, setSelectedPlatformKey] = useState<string | null>(null);
  const [platformVersionSelections, setPlatformVersionSelections] = useState<Record<string, string>>({});
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
  const localBoardScanGenerationRef = useRef(0);
  const localBoardAutoScanActiveRef = useRef(false);
  const localBoardMonitoringPausedRef = useRef(false);
  const localBoardMonitoringResumeTimerRef = useRef<number | null>(null);
  const localBoardReconnectScanSignatureRef = useRef('');
  const localBoardUploadInProgressRef = useRef(false);
  const localBoardUploadProgressRef = useRef<UsbUploadProgressTask | null>(null);
  const verifyInProgressRef = useRef(false);

  const deferredLibraryQuery = useDeferredValue(libraryQuery);
  const deferredPlatformQuery = useDeferredValue(platformQuery);
  const deferredProjectQuery = useDeferredValue(projectQuery);
  const librarySearchTerm = deferredLibraryQuery.trim();
  const platformSearchTerm = deferredPlatformQuery.trim();
  const allLibraryResults = useMemo(() => {
    const nextLibraries = applyLibraryInstalledState(librarySearchTerm ? libraryResults : defaultLibraryResults, installedLibraries);
    if (!librarySearchTerm) {
      return nextLibraries.filter((library) => !library.installed);
    }

    const librariesByName = new Map<string, LibraryEntry>(nextLibraries.map((library) => [normalizePackageKey(library.name), library]));
    for (const installedLibrary of installedLibraries) {
      if (!libraryMatchesSearch(installedLibrary, librarySearchTerm)) {
        continue;
      }

      const key = normalizePackageKey(installedLibrary.name);
      if (!librariesByName.has(key)) {
        librariesByName.set(key, { ...installedLibrary, installed: true });
      }
    }

    return Array.from(librariesByName.values());
  }, [defaultLibraryResults, installedLibraries, libraryResults, librarySearchTerm]);
  const installedLibraryResults = useMemo(() => {
    const nextLibraries = installedLibraries.map((library) => ({ ...library, installed: true }));
    return librarySearchTerm ? nextLibraries.filter((library) => libraryMatchesSearch(library, librarySearchTerm)) : nextLibraries;
  }, [installedLibraries, librarySearchTerm]);
  const visibleLibraryResults = libraryManagerTab === 'installed' ? installedLibraryResults : allLibraryResults;
  const selectedLibrary = useMemo(() => {
    if (!selectedLibraryKey) {
      return null;
    }

    return visibleLibraryResults.find((library) => normalizePackageKey(library.name) === selectedLibraryKey) ?? null;
  }, [selectedLibraryKey, visibleLibraryResults]);
  const visiblePlatformResults = useMemo(
    () => applyPlatformInstalledState(platformSearchTerm ? platformResults : defaultPlatformResults, installedPlatforms),
    [defaultPlatformResults, installedPlatforms, platformResults, platformSearchTerm],
  );
  const selectedPlatform = useMemo(() => {
    if (!selectedPlatformKey) {
      return null;
    }

    const visiblePlatform = visiblePlatformResults.find((platform) => normalizePackageKey(platform.id) === selectedPlatformKey);
    if (visiblePlatform) {
      return visiblePlatform;
    }

    return installedPlatforms.find((platform) => normalizePackageKey(platform.id) === selectedPlatformKey) ?? null;
  }, [installedPlatforms, selectedPlatformKey, visiblePlatformResults]);
  const visibleLocalBoardCatalog = useMemo(() => {
    const query = localBoardCatalogQuery.trim().toLowerCase();
    return localBoardCatalog.filter((option) => boardOptionMatchesQuery(option, query)).slice(0, 80);
  }, [localBoardCatalog, localBoardCatalogQuery]);
  const hasConfiguredLocalBoard = useMemo(() => {
    return localBoardProfiles.length > 0 || manualLocalBoardKeys.length > 0;
  }, [localBoardProfiles.length, manualLocalBoardKeys.length]);
  const syncedTabs = useMemo(() => tabs.map(syncFileTabDirtyState), [tabs]);
  const activeTab = syncedTabs.find((tab) => tab.id === activeTabId) ?? syncedTabs[0] ?? null;
  const activeTabScrollId = activeTab?.id ?? null;
  const activeTabScrollPath = activeTab?.path ?? null;
  const selectedBoard = boards.find((board) => board.$id === selectedBoardId) ?? null;
  const localBoardRows = useMemo<LocalBoardRow[]>(() => {
    const usedDetectionKeys = new Set<string>();
    const availableDetections = () => detectedLocalBoards.filter((detection) => !usedDetectionKeys.has(localBoardDetectionUsageKey(detection)));

    const takeDetection = (identity: LocalBoardHardwareIdentity, selectedPortPath?: string) => {
      const exactPort = normalizeLocalBoardHardwareValue(selectedPortPath || localBoardIdentityPort(identity));
      const exactDetection = exactPort
        ? availableDetections().find((detection) => normalizeLocalBoardHardwareValue(detection.port) === exactPort) ?? null
        : null;
      const detection = exactDetection ?? pickBestLocalBoardHardwareMatch(availableDetections(), identity);
      if (detection) {
        usedDetectionKeys.add(localBoardDetectionUsageKey(detection));
      }
      return detection;
    };

    const createRow = (key: string, profile: LocalBoardProfile | null, edit: LocalBoardEdit, source: LocalBoardRow['source']): LocalBoardRow => {
      const configuredPortPath = edit.port ?? profile?.port ?? '';
      const detection = takeDetection(profile ?? { port: configuredPortPath }, configuredPortPath);
      const fqbn = firstUploadableBoardFqbn(edit.fqbn, profile?.fqbn, detection?.fqbn);
      const selectedPortPath = edit.port ?? detection?.port ?? profile?.port ?? '';
      const matchingLivePort = pickSafeLocalBoardPortMatch(localBoardPorts, profile, selectedPortPath);
      const detectionPort = detection ? portOptionFromBoard(detection) : null;
      const livePort = matchingLivePort ?? detectionPort;
      const port = livePort?.path || selectedPortPath || '';
      const boardLabel = edit.boardLabel || profile?.boardLabel || detection?.boardLabel || (fqbn ? getBoardOptionLabel(fqbn) : 'Local board');
      const connected = Boolean(detection || livePort);
      const savedPort = profile?.port || '';
      const portChanged = Boolean(
        connected &&
          savedPort &&
          port &&
          normalizeLocalBoardHardwareValue(savedPort) !== normalizeLocalBoardHardwareValue(port),
      );

      return {
        key,
        profileId: profile?.id,
        profile: profile ?? undefined,
        detection: detection ?? undefined,
        source,
        connected,
        name: edit.name ?? profile?.name ?? '',
        fqbn,
        port,
        boardLabel,
        manufacturer: detection?.manufacturer || livePort?.manufacturer || profile?.manufacturer || (source === 'manual' ? 'Manual' : 'Unknown'),
        protocol: detection?.protocol || livePort?.protocol || profile?.protocol || 'serial',
        protocolLabel: detection?.protocolLabel || livePort?.protocolLabel || profile?.protocolLabel || 'Serial',
        vendorId: detection?.vendorId ?? livePort?.vendorId ?? profile?.vendorId,
        productId: detection?.productId ?? livePort?.productId ?? profile?.productId,
        serialNumber: detection?.serialNumber ?? livePort?.serialNumber ?? profile?.serialNumber,
        pnpId: detection?.pnpId ?? livePort?.pnpId ?? profile?.pnpId,
        locationId: detection?.locationId ?? livePort?.locationId ?? profile?.locationId,
        fingerprint: detection?.fingerprint || profile?.fingerprint || `manual:${key}:${port}:${fqbn}`,
        confidence: detection?.confidence ?? profile?.confidence ?? null,
        confidenceLabel: detection?.confidenceLabel,
        cloudBoardId: profile?.cloudBoardId || '',
        cloudLinkedAt: profile?.cloudLinkedAt || '',
        lastCloudProvisionedAt: profile?.lastCloudProvisionedAt || '',
        lastCloudUsbUploadAt: profile?.lastCloudUsbUploadAt || '',
        sourceCodeVisibility: profile?.sourceCodeVisibility || 'private',
        portChanged,
        stalePort: portChanged ? savedPort : '',
        detectionSource: detection?.detectionSource,
        matchingBoards: detection?.matchingBoards,
        ai: detection?.ai,
      };
    };

    const rows = [
      ...localBoardProfiles.map((profile) => {
        const key = localBoardProfileKey(profile.id);
        return createRow(key, profile, localBoardEdits[key] ?? {}, 'saved');
      }),
      ...manualLocalBoardKeys.map((key) => createRow(key, null, localBoardEdits[key] ?? {}, 'manual')),
    ];

    for (const detection of availableDetections()) {
      const key = localBoardDetectedKey(detection);
      rows.push(createRow(key, null, localBoardEdits[key] ?? { fqbn: detection.fqbn, boardLabel: detection.boardLabel, port: detection.port }, 'detected'));
    }

    return rows;
  }, [detectedLocalBoards, localBoardEdits, localBoardPorts, localBoardProfiles, manualLocalBoardKeys]);
  const selectedLocalBoard = localBoardRows.find((row) => row.profileId && row.profileId === selectedLocalBoardId)
    ?? localBoardRows.find((row) => row.profileId && canUploadLocalBoard(row))
    ?? localBoardRows.find((row) => row.profileId)
    ?? null;
  const selectedBoardLinkedLocalRow = selectedBoard
    ? localBoardRows.find((row) => row.profileId && row.cloudBoardId === selectedBoard.$id) ?? null
    : null;
  const parsedEditorBoardSelection = parseEditorBoardValue(editorBoardSelection);
  const selectedEditorLocalBoard = parsedEditorBoardSelection.kind === 'local'
    ? localBoardRows.find((row) => row.profileId === parsedEditorBoardSelection.id) ?? selectedLocalBoard
    : parsedEditorBoardSelection.kind === 'cloud'
      ? null
      : selectedLocalBoard;
  const selectedEditorCloudBoard = parsedEditorBoardSelection.kind === 'cloud'
    ? boards.find((board) => board.$id === parsedEditorBoardSelection.id) ?? selectedBoard
    : selectedEditorLocalBoard
      ? null
      : selectedBoard;
  const editorBoardSelectionValue = selectedEditorCloudBoard
    ? editorCloudBoardValue(selectedEditorCloudBoard.$id)
    : selectedEditorLocalBoard?.profileId
      ? editorLocalBoardValue(selectedEditorLocalBoard.profileId)
      : '';
  const selectedEditorCloudStatus = selectedEditorCloudBoard ? calculateBoardStatus(selectedEditorCloudBoard.lastSeen, selectedEditorCloudBoard.status) : null;
  const editorBoardStatusText = selectedEditorCloudBoard
    ? `OTA ${selectedEditorCloudStatus}`
    : selectedEditorLocalBoard
      ? isUploadableBoardFqbn(selectedEditorLocalBoard.fqbn)
        ? canUploadLocalBoard(selectedEditorLocalBoard)
          ? selectedEditorLocalBoard.port || getBoardOptionLabel(selectedEditorLocalBoard.fqbn)
          : 'Disconnected'
        : 'Set exact board type'
      : localBoardProfiles.length === 0 && boards.length === 0
        ? 'Default Uno'
        : 'No board';
  const editorBoardStatusConnected = Boolean(
    (selectedEditorLocalBoard && selectedEditorLocalBoard.connected) ||
      (selectedEditorCloudBoard && selectedEditorCloudStatus === 'online'),
  );
  const editorUploadBusy = isLocalUploadBusyAction(busyAction) || busyAction === 'upload';
  const editorUploadDisabled = !activeTab ||
    busyAction === 'compile' ||
    editorUploadBusy ||
    (selectedEditorCloudBoard ? false : !canAttemptLocalUpload(selectedEditorLocalBoard));
  const editorUploadLabel = selectedEditorCloudBoard
    ? busyAction === 'upload'
      ? 'Uploading OTA...'
      : 'Upload OTA'
    : busyAction === 'verify-before-upload'
      ? 'Verifying...'
      : busyAction === 'prepare-upload'
        ? 'Preparing...'
        : busyAction === 'upload-local'
          ? 'Uploading...'
          : 'Upload';
  const usbWifiTargetRow = usbWifiProfileId
    ? localBoardRows.find((row) => row.profileId === usbWifiProfileId) ?? null
    : null;
  useEffect(() => {
    setSelectedLinkLocalProfileId(selectedBoardLinkedLocalRow?.profileId ?? '');
  }, [selectedBoard?.$id, selectedBoardLinkedLocalRow?.profileId]);
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
  const editorSelectionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const agentDiffDecorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const agentDiffViewZoneIdsRef = useRef<string[]>([]);
  const projectProblemWidgetOpenedRef = useRef(new Set<string>());
  const tabsRef = useRef<FileTab[]>(tabs);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const editorTabsScrollHostRef = useRef<HTMLDivElement | null>(null);
  const workspacePathRef = useRef<string | null>(workspacePath);
  const projectIntegrityRef = useRef<ProjectIntegrityState>(projectIntegrity);
  const editorValueRef = useRef(editorValue);
  const workspaceActiveRef = useRef(active);
  const saveInProgressRef = useRef(false);
  const consoleOutputRef = useRef<HTMLDivElement | null>(null);
  const toastCounterRef = useRef(1);
  const toastsRef = useRef<Toast[]>(toasts);
  const toolchainNotificationToastIdsRef = useRef(new Map<string, number>());
  const boardCodeProgressToastIdsRef = useRef(new Map<string, number>());
  const libraryInstallToastIdsRef = useRef(new Map<string, number>());
  const libraryMigrationNotificationIdRef = useRef<string | null>(null);
  const libraryMigrationToastIdRef = useRef<number | null>(null);
  const platformInstallProgressRef = useRef<PlatformInstallProgressTask | null>(null);
  const firmwareReleaseProgressRef = useRef<FirmwareReleaseProgressTask | null>(null);
  const libraryMetadataRequestsRef = useRef(new Map<string, Promise<LibraryEntry | null>>());
  const agentReviewIdCounterRef = useRef(1);
  const agentReviewNoticeCounterRef = useRef(1);
  const [treeTrashMap] = useState(() => new Map<string, string>());
  const panelSizesRef = useRef<PanelSizes>(panelSizes);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const editorThemeName = resolvedTheme === 'light' ? 'tantalum-minimal-light' : 'tantalum-minimal-dark';
  const activeEditorFilePath = activeTab?.path.startsWith('untitled:') ? activeTab.name : activeTab?.path;
  const activeEditorLanguage = getEditorLanguage(activeEditorFilePath);
  const activeEditorPath = toMonacoPath(activeTab?.path);
  const activeAgentChange = useMemo(() => {
    if (!pendingAgentReview || !activeTab || !workspacePath) {
      return null;
    }

    return (
      pendingAgentReview.files.find((file) => {
        const targetPath = joinPath(workspacePath, file.path);
        return isSameFileTabPath(targetPath, activeTab.path);
      }) ?? null
    );
  }, [activeTab, pendingAgentReview, workspacePath]);
  const dirtyWorkspaceFilePaths = useMemo(
    () => syncedTabs.filter((tab) => !tab.path.startsWith('untitled:') && tab.isDirty).map((tab) => tab.path),
    [syncedTabs],
  );
  const readActiveEditorSelection = useCallback((): AgentEditorSelectionContext | null => {
    const editorInstance = editorRef.current;
    const model = editorInstance?.getModel() ?? null;
    const selectedRange = editorInstance?.getSelection() ?? null;
    const currentTab =
      (activeTabIdRef.current ? tabsRef.current.find((tab) => tab.id === activeTabIdRef.current) : null) ??
      tabsRef.current[0] ??
      null;

    if (!editorInstance || !model || !selectedRange || !currentTab || currentTab.path.startsWith('untitled:') || currentTab.agentPreview) {
      return null;
    }

    if (selectedRange.startLineNumber === selectedRange.endLineNumber && selectedRange.startColumn === selectedRange.endColumn) {
      return null;
    }

    const lineStart = Math.max(1, Math.min(selectedRange.startLineNumber, selectedRange.endLineNumber));
    const lineEnd = Math.min(model.getLineCount(), Math.max(selectedRange.startLineNumber, selectedRange.endLineNumber));
    const content = model.getValueInRange({
      startLineNumber: lineStart,
      startColumn: 1,
      endLineNumber: lineEnd,
      endColumn: model.getLineMaxColumn(lineEnd),
    });

    if (!content.trim()) {
      return null;
    }

    return {
      path: currentTab.path,
      name: currentTab.name,
      content,
      lineStart,
      lineEnd,
    };
  }, []);
  const refreshActiveEditorSelection = useCallback(() => {
    setActiveEditorSelection(readActiveEditorSelection());
  }, [readActiveEditorSelection]);
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
    if (!workspacePath) {
      return;
    }

    writeStoredAgentReview(workspacePath, pendingAgentReview);
  }, [pendingAgentReview, workspacePath]);

  useEffect(() => {
    if (!activeTabScrollId || !activeTabScrollPath || sidebar !== 'explorer' || typeof window === 'undefined') {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollActiveEditorTabIntoView(editorTabsScrollHostRef.current);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeTabScrollId, activeTabScrollPath, sidebar, syncedTabs.length]);

  useEffect(() => {
    if (!workspacePath) {
      return;
    }

    writeStoredWorkspaceEditorTabs(workspacePath, syncedTabs, activeTabId);
  }, [activeTabId, syncedTabs, workspacePath]);

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

  function applyEditorTabState(nextTabs: FileTab[], preferredActiveTabId: string | null) {
    const syncedNextTabs = nextTabs.map(syncFileTabDirtyState);
    const preferredTab = preferredActiveTabId ? syncedNextTabs.find((tab) => tab.id === preferredActiveTabId) ?? null : null;
    const nextActiveTab = preferredTab ?? syncedNextTabs[0] ?? null;
    const nextActiveTabId = nextActiveTab?.id ?? null;
    const nextEditorValue = nextActiveTab?.content ?? '';

    tabsRef.current = syncedNextTabs;
    activeTabIdRef.current = nextActiveTabId;
    editorValueRef.current = nextEditorValue;
    setTabs(syncedNextTabs);
    setActiveTabId(nextActiveTabId);
    setEditorValue(nextEditorValue);
  }

  function snapshotCurrentWorkspaceEditorTabs() {
    const currentWorkspacePath = workspacePathRef.current;
    if (!currentWorkspacePath) {
      return;
    }

    writeStoredWorkspaceEditorTabs(currentWorkspacePath, tabsRef.current, activeTabIdRef.current);
  }

  function getUnsavedEditorTabs() {
    return tabsRef.current.map(syncFileTabDirtyState).filter((tab) => Boolean(tab.isDirty));
  }

  function confirmWorkspaceSwitch(targetWorkspacePath: string) {
    const currentWorkspacePath = workspacePathRef.current;
    if (currentWorkspacePath && areSameWorkspaceEditorStoragePath(currentWorkspacePath, targetWorkspacePath)) {
      return true;
    }

    const unsavedTabs = getUnsavedEditorTabs();
    if (unsavedTabs.length > 0) {
      const tabLabel = unsavedTabs.length === 1 ? 'tab has' : 'tabs have';
      const message = currentWorkspacePath
        ? `Switch Projects? ${unsavedTabs.length} unsaved ${tabLabel} changes. They will be kept with ${fileNameFromPath(currentWorkspacePath)} and restored when you reopen it.`
        : `Open Project? ${unsavedTabs.length} unsaved ${tabLabel} changes outside a Project. They will be closed if you continue.`;

      if (!window.confirm(message)) {
        return false;
      }
    }

    snapshotCurrentWorkspaceEditorTabs();
    return true;
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

  const ensureManagerDetailPanelVisible = useCallback(() => {
    onRightPanelOpenChange(true);
    setPanelSizes((current) => {
      const targetRightWidth = Math.min(MANAGER_DETAIL_PANEL_WIDTH, getPanelMaxSize('right', current));
      if (current.right >= targetRightWidth) {
        return current;
      }

      return normalizePanelSizes({ ...current, right: targetRightWidth });
    });
  }, [onRightPanelOpenChange]);

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

  function dismissToast(id: number) {
    setToasts((current) => {
      const toast = current.find((item) => item.id === id);
      if (toast?.notificationId) {
        toolchainNotificationToastIdsRef.current.delete(toast.notificationId);
      }

      return current.filter((item) => item.id !== id);
    });
  }

  function pushToast(
    message: string,
    tone: Toast['tone'] = 'info',
    actions?: Toast['actions'],
    options?: Pick<Toast, 'detail' | 'persistent' | 'progress' | 'progressLabel' | 'notificationId'>,
  ) {
    const id = toastCounterRef.current++;
    setToasts((current) => [...current, { id, tone, message, actions, ...options }]);
    if (options?.notificationId) {
      toolchainNotificationToastIdsRef.current.set(options.notificationId, id);
    }
    if (!options?.persistent) {
      window.setTimeout(() => {
        dismissToast(id);
      }, 4000);
    }

    return id;
  }

  function updateToast(id: number, patch: Partial<Omit<Toast, 'id'>>) {
    setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)));
  }

  function finishToast(id: number, patch: Partial<Omit<Toast, 'id'>>, timeoutMs = 5000) {
    updateToast(id, { ...patch, persistent: false });
    window.setTimeout(() => {
      dismissToast(id);
    }, timeoutMs);
  }

  function isActiveToolchainNotification(notification: Pick<ToolchainNotification, 'status'>) {
    return notification.status === 'queued' || notification.status === 'running';
  }

  function getToolchainToastTone(notification: Pick<ToolchainNotification, 'status'>): Toast['tone'] {
    if (notification.status === 'error') {
      return 'error';
    }

    if (notification.status === 'success') {
      return 'success';
    }

    return 'info';
  }

  function persistToolchainNotification(notification: ToolchainNotificationInput) {
    void window.tantalum.notifications.upsert(notification);
  }

  function getFirmwareReleaseTitle(task: FirmwareReleaseProgressTask) {
    if (task.phase === 'storage' || task.phase === 'queue') {
      return `Uploading ${task.boardName} ${task.version}`;
    }

    if (task.phase === 'complete') {
      return `Uploaded ${task.boardName} ${task.version}`;
    }

    return `Building ${task.boardName} ${task.version}`;
  }

  function persistFirmwareReleaseProgress(task: FirmwareReleaseProgressTask, status: ToolchainNotificationInput['status'] = 'running') {
    persistToolchainNotification({
      id: task.notificationId,
      kind: 'firmware-upload',
      title: getFirmwareReleaseTitle(task),
      detail: task.detail,
      status,
      phase: task.phase,
      progress: task.progress,
      name: task.boardName,
      version: task.version,
      target: task.boardName,
      metadata: {
        boardId: task.boardId,
        boardType: task.boardType,
        filename: task.filename,
      },
    });
  }

  function clearFirmwareReleaseProgressTimer(task: FirmwareReleaseProgressTask | null) {
    if (task?.timerId !== null && task?.timerId !== undefined) {
      window.clearInterval(task.timerId);
    }
  }

  function updateFirmwareReleaseProgress(notificationId: string, patch: Partial<FirmwareReleaseProgressTask>, status: ToolchainNotificationInput['status'] = 'running') {
    const current = firmwareReleaseProgressRef.current;
    if (!current || current.notificationId !== notificationId) {
      return null;
    }

    const now = currentTimestampMs();
    const nextPhase = patch.phase ?? current.phase;
    const nextProgress = clampPercent(Math.max(current.progress, patch.progress ?? current.progress));
    const next: FirmwareReleaseProgressTask = {
      ...current,
      ...patch,
      phase: nextPhase,
      phaseStartedAt: nextPhase === current.phase ? current.phaseStartedAt : now,
      detail: sanitizeProgressDetail(patch.detail ?? current.detail, FIRMWARE_RELEASE_PHASE_CONFIG[nextPhase].fallbackDetail),
      progress: nextProgress,
    };

    firmwareReleaseProgressRef.current = next;
    persistFirmwareReleaseProgress(next, status);
    updateToast(next.toastId, {
      message: getFirmwareReleaseTitle(next),
      detail: next.detail,
      tone: status === 'error' ? 'error' : status === 'success' ? 'success' : 'info',
      persistent: status === 'running',
      progress: next.progress,
      progressLabel: formatReleaseProgressLabel(next.progress),
    });

    return next;
  }

  function startFirmwareReleaseProgressTask(task: Omit<FirmwareReleaseProgressTask, 'timerId'>) {
    clearFirmwareReleaseProgressTimer(firmwareReleaseProgressRef.current);

    const nextTask: FirmwareReleaseProgressTask = { ...task, timerId: null };
    const timerId = window.setInterval(() => {
      const current = firmwareReleaseProgressRef.current;
      if (!current || current.notificationId !== task.notificationId) {
        window.clearInterval(timerId);
        return;
      }

      updateFirmwareReleaseProgress(current.notificationId, {
        progress: nextTimedFirmwareReleaseProgress(current),
      });
    }, FIRMWARE_RELEASE_PROGRESS_TICK_MS);

    firmwareReleaseProgressRef.current = { ...nextTask, timerId };
    updateFirmwareReleaseProgress(task.notificationId, { progress: task.progress });
  }

  function finishFirmwareReleaseProgressTask(notificationId: string, patch?: Partial<FirmwareReleaseProgressTask>, status: ToolchainNotificationInput['status'] = 'success') {
    const task = updateFirmwareReleaseProgress(notificationId, patch ?? {}, status);
    if (task) {
      clearFirmwareReleaseProgressTimer(task);
      firmwareReleaseProgressRef.current = null;
    }

    return task;
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

  const refreshAgentRestorePoints = useCallback(async (targetWorkspacePath = workspacePath) => {
    if (!active || !targetWorkspacePath) {
      setAgentRestorePoints([]);
      return;
    }

    const result = await window.tantalum.agent.listRestorePoints({ workspacePath: targetWorkspacePath });
    if (result.success) {
      setAgentRestorePoints(result.restorePoints);
    }
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

  useEffect(() => {
    void refreshAgentRestorePoints();
  }, [refreshAgentRestorePoints]);

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

  function isSourceSnapshotFilePath(filePath: string) {
    return SOURCE_SNAPSHOT_EXTENSIONS.has(`.${fileNameFromPath(filePath).split('.').pop()?.toLowerCase() || ''}`);
  }

  function sanitizeSourceSnapshotPathPart(part: string) {
    const safePart = Array.from(part).map((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character;
    }).join('');
    return safePart.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
  }

  function sanitizeSourceSnapshotRelativePath(filePath: string, fallback = 'sketch.ino') {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => part !== '.' && part !== '..')
      .map(sanitizeSourceSnapshotPathPart);
    return parts.join('/') || fallback;
  }

  function sourceSnapshotByteLength(content: string) {
    return new TextEncoder().encode(content).byteLength;
  }

  function shouldSkipSourceSnapshotDirectory(name: string) {
    const normalized = name.toLowerCase();
    return normalized.startsWith('.')
      || ['.git', '.tantalum-trash', 'node_modules', 'dist', 'build', '.next', '.vite', 'out', 'target', 'extracted-board-code'].includes(normalized);
  }

  function isArduinoSketchFilePath(filePath: string) {
    return /\.(ino|pde)$/i.test(fileNameFromPath(filePath));
  }

  function stripArduinoCodeForLifecycleScan(code: string) {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\r\n]*/g, ' ')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
  }

  function hasArduinoLifecycleFunction(code: string) {
    const stripped = stripArduinoCodeForLifecycleScan(code);
    return /\bvoid\s+(setup|loop)\s*\(/.test(stripped);
  }

  function hasArduinoLifecyclePair(code: string) {
    const stripped = stripArduinoCodeForLifecycleScan(code);
    return /\bvoid\s+setup\s*\(/.test(stripped) && /\bvoid\s+loop\s*\(/.test(stripped);
  }

  function normalizeProjectEntryFileName(value: string | null | undefined) {
    const candidate = String(value || '').trim();
    if (!candidate || candidate.includes('/') || candidate.includes('\\')) {
      return null;
    }
    const hasUnsafeCharacter = Array.from(candidate).some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint < 32 || '<>:"/\\|?*'.includes(character);
    });
    if (hasUnsafeCharacter || !/\.ino$/i.test(candidate) || candidate.replace(/\.ino$/i, '').trim().length === 0) {
      return null;
    }
    return candidate;
  }

  function projectMetadataPath(rootPath: string) {
    return joinPath(joinPath(rootPath, PROJECT_METADATA_DIRECTORY), PROJECT_METADATA_FILE);
  }

  function isRootInoProjectFile(filePath: string, rootPath = workspacePathRef.current) {
    if (!rootPath || !isPathInsideRoot(filePath, rootPath)) {
      return false;
    }
    const relativePath = relativePathFromRoot(filePath, rootPath);
    const parts = relativePath?.replace(/\\/g, '/').split('/').filter(Boolean) ?? [];
    return parts.length === 1 && /\.ino$/i.test(parts[0]);
  }

  function rootProjectFileName(filePath: string, rootPath = workspacePathRef.current) {
    if (!rootPath || !isRootInoProjectFile(filePath, rootPath)) {
      return null;
    }
    const relativePath = relativePathFromRoot(filePath, rootPath);
    return relativePath?.replace(/\\/g, '/') ?? null;
  }

  function findOpenTabForPath(filePath: string) {
    return tabsRef.current.map(syncFileTabDirtyState).find((tab) => !isTemporaryFileTab(tab) && isSameFileTabPath(tab.path, filePath)) ?? null;
  }

  function readOpenTabContent(filePath: string) {
    const openTab = findOpenTabForPath(filePath);
    if (!openTab) {
      return null;
    }
    return openTab.id === activeTabIdRef.current ? editorRef.current?.getValue() ?? editorValueRef.current : openTab.content;
  }

  async function readProjectMetadata(rootPath: string): Promise<{ entryFile: string | null; missing: boolean; error: string | null }> {
    const result = await window.tantalum.fs.readFile(projectMetadataPath(rootPath));
    if (!result.success) {
      return { entryFile: null, missing: true, error: null };
    }

    try {
      const parsed = JSON.parse(result.content) as Partial<ProjectMetadata>;
      const entryFile = parsed.schemaVersion === 1 ? normalizeProjectEntryFileName(parsed.entryFile) : null;
      return { entryFile, missing: false, error: entryFile ? null : 'Project metadata has an invalid entry file.' };
    } catch {
      return { entryFile: null, missing: false, error: 'Project metadata is not valid JSON.' };
    }
  }

  async function writeProjectMetadata(rootPath: string, entryFile: string) {
    const metadataDirectoryResult = await window.tantalum.fs.createFolder(rootPath, PROJECT_METADATA_DIRECTORY);
    if (!metadataDirectoryResult.success && !/exist|already/i.test(metadataDirectoryResult.error)) {
      throw new Error(metadataDirectoryResult.error);
    }

    const metadata: ProjectMetadata = {
      schemaVersion: 1,
      entryFile,
    };
    const writeResult = await window.tantalum.fs.writeFile(projectMetadataPath(rootPath), `${JSON.stringify(metadata, null, 2)}\n`);
    if (!writeResult.success) {
      throw new Error(writeResult.error);
    }
  }

  async function readRootInoLifecycleFiles(rootPath: string) {
    const directory = await window.tantalum.fs.readDirectory(rootPath);
    if (!directory.success) {
      throw new Error(directory.error);
    }

    const rootInoFiles = directory.items
      .filter((item) => !item.isDirectory && /\.ino$/i.test(item.name))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    const lifecycleFiles: string[] = [];
    const lifecycleFunctionFiles: string[] = [];
    const rootFileNames = rootInoFiles.map((item) => item.name);

    for (const item of rootInoFiles) {
      const openContent = readOpenTabContent(item.path);
      let fileContent = openContent;
      if (fileContent === null) {
        const fileResult = await window.tantalum.fs.readFile(item.path);
        fileContent = fileResult.success ? fileResult.content : '';
      }
      if (hasArduinoLifecycleFunction(fileContent)) {
        lifecycleFunctionFiles.push(item.name);
      }
      if (hasArduinoLifecyclePair(fileContent)) {
        lifecycleFiles.push(item.name);
      }
    }

    return { rootFileNames, lifecycleFiles, lifecycleFunctionFiles };
  }

  async function refreshProjectIntegrity(rootPath = workspacePathRef.current) {
    if (!rootPath) {
      projectIntegrityRef.current = EMPTY_PROJECT_INTEGRITY;
      setProjectIntegrity(EMPTY_PROJECT_INTEGRITY);
      return EMPTY_PROJECT_INTEGRITY;
    }

    try {
      const [metadata, lifecycle] = await Promise.all([
        readProjectMetadata(rootPath),
        readRootInoLifecycleFiles(rootPath),
      ]);
      const rootFileNameSet = new Set(lifecycle.rootFileNames.map((name) => name.toLowerCase()));
      let entryFile = metadata.entryFile && rootFileNameSet.has(metadata.entryFile.toLowerCase()) ? metadata.entryFile : null;
      let metadataMissing = metadata.missing;
      let metadataError = metadata.error;
      const entryMissing = Boolean(metadata.entryFile && !entryFile);

      if (!entryFile && lifecycle.lifecycleFiles.length === 1) {
        entryFile = lifecycle.lifecycleFiles[0];
        await writeProjectMetadata(rootPath, entryFile);
        metadataMissing = false;
        metadataError = null;
      }

      const conflictFiles = lifecycle.lifecycleFunctionFiles.filter((name) => !entryFile || name.toLowerCase() !== entryFile.toLowerCase());
      const nextIntegrity: ProjectIntegrityState = {
        loading: false,
        entryFile,
        lifecycleFiles: lifecycle.lifecycleFiles,
        lifecycleFunctionFiles: lifecycle.lifecycleFunctionFiles,
        conflictFiles,
        entryMissing,
        metadataMissing,
        error: metadataError,
      };
      projectIntegrityRef.current = nextIntegrity;
      setProjectIntegrity(nextIntegrity);
      return nextIntegrity;
    } catch (error) {
      const nextIntegrity: ProjectIntegrityState = {
        ...EMPTY_PROJECT_INTEGRITY,
        error: error instanceof Error ? error.message : 'Unable to inspect Project entry point.',
      };
      projectIntegrityRef.current = nextIntegrity;
      setProjectIntegrity(nextIntegrity);
      return nextIntegrity;
    }
  }

  function isWorkspaceMainSketchFileName(name: string) {
    return name.toLowerCase() === WORKSPACE_MAIN_SKETCH_FILE;
  }

  function isWorkspaceEntrySketchFileName(name: string) {
    return Boolean(projectIntegrity.entryFile && name.toLowerCase() === projectIntegrity.entryFile.toLowerCase());
  }

  function isWorkspaceCompiledRootFileName(name: string) {
    const extension = `.${name.split('.').pop()?.toLowerCase() || ''}`;
    return WORKSPACE_COMPILED_ROOT_FILE_EXTENSIONS.has(extension);
  }

  function isStandaloneWorkspaceSketchTab(relativePath: string, content: string, entryFileName = WORKSPACE_MAIN_SKETCH_FILE) {
    const parts = sourceSnapshotPathParts(relativePath);
    return parts.length === 1
      && isArduinoSketchFilePath(parts[0])
      && parts[0].toLowerCase() !== entryFileName.toLowerCase()
      && hasArduinoLifecycleFunction(content);
  }

  function isWorkspaceCompiledRootDirectoryName(name: string) {
    return WORKSPACE_COMPILED_ROOT_DIRECTORIES.has(name.toLowerCase());
  }

  function compareWorkspaceCompiledRootItems(left: { name: string }, right: { name: string }) {
    const leftSrc = isWorkspaceCompiledRootDirectoryName(left.name);
    const rightSrc = isWorkspaceCompiledRootDirectoryName(right.name);
    if (leftSrc !== rightSrc) {
      return leftSrc ? -1 : 1;
    }
    const leftEntry = isWorkspaceEntrySketchFileName(left.name);
    const rightEntry = isWorkspaceEntrySketchFileName(right.name);
    if (leftEntry !== rightEntry) {
      return leftEntry ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  }

  function compareWorkspaceDirectoryItems(left: { name: string; isDirectory: boolean }, right: { name: string; isDirectory: boolean }) {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  }

  function isAllowedSketchChildDirectory(name: string) {
    const normalized = name.toLowerCase();
    return normalized === 'src';
  }

  function sourceSnapshotPathParts(relativePath: string) {
    const normalized = sanitizeSourceSnapshotRelativePath(relativePath).replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean);
  }

  function isWorkspaceCompiledDirectoryFileName(name: string) {
    return !isArduinoSketchFilePath(name) && isWorkspaceCompiledRootFileName(name);
  }

  function isWorkspaceCompiledSnapshotPath(relativePath: string) {
    const parts = sourceSnapshotPathParts(relativePath);
    if (parts.length === 0 || parts.some((part) => shouldSkipSourceSnapshotDirectory(part))) {
      return false;
    }

    if (parts.length === 1) {
      return isWorkspaceCompiledRootFileName(parts[0]);
    }

    return isWorkspaceCompiledRootDirectoryName(parts[0]) && isWorkspaceCompiledDirectoryFileName(parts[parts.length - 1]);
  }

  function isSourceSnapshotPathAllowed(relativePath: string, options: { workspaceCompiled?: boolean } = {}) {
    const normalized = sanitizeSourceSnapshotRelativePath(relativePath).replace(/\\/g, '/');
    const parts = sourceSnapshotPathParts(normalized);
    if (parts.length === 0 || parts.some((part) => shouldSkipSourceSnapshotDirectory(part))) {
      return false;
    }
    if (options.workspaceCompiled) {
      return isWorkspaceCompiledSnapshotPath(normalized);
    }
    if (parts.length === 1) {
      return isSourceSnapshotFilePath(normalized);
    }
    return isAllowedSketchChildDirectory(parts[0]) && isSourceSnapshotFilePath(normalized);
  }

  async function readDirectorySketchScope(dirPath: string) {
    const directory = await window.tantalum.fs.readDirectory(dirPath);
    if (!directory.success) {
      return { sketchFiles: [] as string[], hasProjectMarkers: false };
    }
    return {
      sketchFiles: directory.items
        .filter((item) => !item.isDirectory && isArduinoSketchFilePath(item.name))
        .map((item) => item.name),
      hasProjectMarkers: directory.items.some((item) => !item.isDirectory && SOURCE_SNAPSHOT_PROJECT_ROOT_MARKERS.has(item.name.toLowerCase())),
    };
  }

  function fileStem(filePath: string) {
    return fileNameFromPath(filePath).replace(/\.[^.]+$/g, '').toLowerCase();
  }

  function isStrictArduinoSketchScope(dirPath: string, sketchFiles: string[], hasProjectMarkers: boolean) {
    if (sketchFiles.length === 0) {
      return false;
    }
    const directoryName = fileNameFromPath(dirPath).toLowerCase();
    if (sketchFiles.some((name) => isWorkspaceMainSketchFileName(name))) {
      return true;
    }
    if (sketchFiles.some((name) => fileStem(name) === directoryName)) {
      return true;
    }
    return sketchFiles.length === 1 && !hasProjectMarkers;
  }

  async function resolveSourceSnapshotSketchRoot(tab: FileTab) {
    if (isTemporaryFileTab(tab)) {
      return null;
    }

    const activeParent = parentPath(tab.path);
    if (isArduinoSketchFilePath(tab.path)) {
      return activeParent;
    }

    let current = activeParent;
    const workspaceRoot = workspacePath || '';
    const visited = new Set<string>();
    while (current && !visited.has(normalizeTreePath(current))) {
      visited.add(normalizeTreePath(current));
      if (!workspaceRoot || isPathInsideRoot(current, workspaceRoot)) {
        const scope = await readDirectorySketchScope(current);
        if (isStrictArduinoSketchScope(current, scope.sketchFiles, scope.hasProjectMarkers)) {
          return current;
        }
      }
      if (workspaceRoot && normalizeTreePath(current) === normalizeTreePath(workspaceRoot)) {
        break;
      }
      const next = parentPath(current);
      if (!next || normalizeTreePath(next) === normalizeTreePath(current)) {
        break;
      }
      current = next;
    }
    return null;
  }

  async function buildBoardCodeSourceSnapshot(boardName: string, metadata: Record<string, unknown> = {}): Promise<BoardCodeSourceSnapshotInput | null> {
    const currentTab = activeTab;
    if (!currentTab) {
      return null;
    }

    const files = new Map<string, { path: string; content: string }>();
    let totalBytes = 0;
    const addFile = (relativePath: string, content: string, options: { workspaceCompiled?: boolean } = {}) => {
      const sanitizedPath = sanitizeSourceSnapshotRelativePath(relativePath);
      if (!isSourceSnapshotPathAllowed(sanitizedPath, options)) {
        return;
      }
      const bytes = sourceSnapshotByteLength(content);
      const key = sanitizedPath.toLowerCase();
      const existing = files.get(key);
      const existingBytes = existing ? sourceSnapshotByteLength(existing.content) : 0;
      if (bytes > SOURCE_SNAPSHOT_MAX_FILE_BYTES || totalBytes - existingBytes + bytes > SOURCE_SNAPSHOT_MAX_TOTAL_BYTES) {
        return;
      }
      if (!existing) {
        totalBytes += bytes;
      } else {
        totalBytes -= existingBytes;
        totalBytes += bytes;
      }
      files.set(key, { path: sanitizedPath, content });
    };

    const activeContent = editorValueRef.current;
    const workspaceSnapshotRoot = !isTemporaryFileTab(currentTab) && workspacePath && isPathInsideRoot(currentTab.path, workspacePath)
      ? workspacePath
      : null;
    const workspaceEntryFileName = workspaceSnapshotRoot ? resolveWorkspaceSketchEntryFileName(currentTab) : WORKSPACE_MAIN_SKETCH_FILE;
    const sketchRoot = workspaceSnapshotRoot || await resolveSourceSnapshotSketchRoot(currentTab);
    const snapshotScope: 'workspace-compiled' | 'sketch' | 'active-file' = workspaceSnapshotRoot ? 'workspace-compiled' : sketchRoot ? 'sketch' : 'active-file';
    let activeRelativePath = isTemporaryFileTab(currentTab) ? currentTab.name : fileNameFromPath(currentTab.path);

    if (workspaceSnapshotRoot) {
      const visitCompiledDirectory = async (dirPath: string) => {
        if (files.size >= SOURCE_SNAPSHOT_MAX_FILES || totalBytes >= SOURCE_SNAPSHOT_MAX_TOTAL_BYTES) {
          return;
        }
        const directory = await window.tantalum.fs.readDirectory(dirPath);
        if (!directory.success) {
          return;
        }

        const sortedItems = [...directory.items].sort(compareWorkspaceDirectoryItems);
        for (const item of sortedItems) {
          if (files.size >= SOURCE_SNAPSHOT_MAX_FILES || totalBytes >= SOURCE_SNAPSHOT_MAX_TOTAL_BYTES) {
            break;
          }

          const relativePath = relativePathFromRoot(item.path, workspaceSnapshotRoot) || item.name;
          const parts = sourceSnapshotPathParts(relativePath);
          if (parts.length === 0 || parts.some((part) => shouldSkipSourceSnapshotDirectory(part))) {
            continue;
          }

          if (item.isDirectory) {
            if (isWorkspaceCompiledRootDirectoryName(parts[0])) {
              await visitCompiledDirectory(item.path);
            }
            continue;
          }

          if (!isSourceSnapshotPathAllowed(relativePath, { workspaceCompiled: true })) {
            continue;
          }
          const file = await window.tantalum.fs.readFile(item.path);
          if (!file.success) {
            continue;
          }
          if (isStandaloneWorkspaceSketchTab(relativePath, file.content, workspaceEntryFileName)) {
            continue;
          }
          addFile(relativePath, file.content, { workspaceCompiled: true });
        }
      };

      await visitCompiledDirectory(workspaceSnapshotRoot);
      for (const tab of tabsRef.current.map(syncFileTabDirtyState)) {
        if (isTemporaryFileTab(tab) || !isPathInsideRoot(tab.path, workspaceSnapshotRoot)) {
          continue;
        }
        const relativePath = relativePathFromRoot(tab.path, workspaceSnapshotRoot) || tab.name;
        if (!isSourceSnapshotPathAllowed(relativePath, { workspaceCompiled: true })) {
          continue;
        }
        const content = tab.id === currentTab.id ? activeContent : tab.content;
        if (isStandaloneWorkspaceSketchTab(relativePath, content, workspaceEntryFileName)) {
          continue;
        }
        addFile(relativePath, content, { workspaceCompiled: true });
      }
      activeRelativePath = relativePathFromRoot(currentTab.path, workspaceSnapshotRoot) || currentTab.name;
      if (isSourceSnapshotPathAllowed(activeRelativePath, { workspaceCompiled: true })) {
        if (!isStandaloneWorkspaceSketchTab(activeRelativePath, activeContent, workspaceEntryFileName)) {
          addFile(activeRelativePath, activeContent, { workspaceCompiled: true });
        }
      }
    } else if (!sketchRoot || isTemporaryFileTab(currentTab)) {
      const fallbackName = currentTab.name && isSourceSnapshotFilePath(currentTab.name) ? currentTab.name : 'sketch.ino';
      activeRelativePath = isTemporaryFileTab(currentTab) ? fallbackName : fileNameFromPath(currentTab.path);
      addFile(activeRelativePath, activeContent);
    } else {
      const visitDirectory = async (dirPath: string) => {
        if (files.size >= SOURCE_SNAPSHOT_MAX_FILES || totalBytes >= SOURCE_SNAPSHOT_MAX_TOTAL_BYTES) {
          return;
        }
        const directory = await window.tantalum.fs.readDirectory(dirPath);
        if (!directory.success) {
          return;
        }

        const sortedItems = [...directory.items].sort((left, right) => {
          if (left.isDirectory !== right.isDirectory) {
            return left.isDirectory ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
        for (const item of sortedItems) {
          if (files.size >= SOURCE_SNAPSHOT_MAX_FILES || totalBytes >= SOURCE_SNAPSHOT_MAX_TOTAL_BYTES) {
            break;
          }
          if (item.isDirectory) {
            const relativeDirectory = relativePathFromRoot(item.path, sketchRoot) || item.name;
            const parts = sanitizeSourceSnapshotRelativePath(relativeDirectory).split('/').filter(Boolean);
            if (parts.length > 0 && isAllowedSketchChildDirectory(parts[0]) && !parts.some((part) => shouldSkipSourceSnapshotDirectory(part))) {
              await visitDirectory(item.path);
            }
            continue;
          }
          const relativePath = relativePathFromRoot(item.path, sketchRoot) || item.name;
          if (!isSourceSnapshotPathAllowed(relativePath)) {
            continue;
          }
          const file = await window.tantalum.fs.readFile(item.path);
          if (!file.success) {
            continue;
          }
          addFile(relativePath, file.content);
        }
      };

      await visitDirectory(sketchRoot);
      for (const tab of tabsRef.current.map(syncFileTabDirtyState)) {
        if (isTemporaryFileTab(tab) || !isPathInsideRoot(tab.path, sketchRoot)) {
          continue;
        }
        const relativePath = relativePathFromRoot(tab.path, sketchRoot) || tab.name;
        if (!isSourceSnapshotPathAllowed(relativePath)) {
          continue;
        }
        addFile(relativePath, tab.id === currentTab.id ? activeContent : tab.content);
      }
      activeRelativePath = relativePathFromRoot(currentTab.path, sketchRoot) || currentTab.name;
      addFile(activeRelativePath, activeContent);
    }

    const collectedFiles = Array.from(files.values());
    if (collectedFiles.length === 0) {
      return null;
    }

    const fileHashes: Record<string, string> = {};
    for (const file of collectedFiles) {
      fileHashes[file.path] = await sha256Hex(file.content);
    }

    return {
      name: boardName || currentTab.name || 'sketch',
      files: collectedFiles,
      metadata: {
        manifestVersion: 2,
        boardName,
        workspacePath,
        sketchRoot,
        snapshotScope,
        ...(snapshotScope === 'workspace-compiled'
          ? {
              entryFileName: workspaceEntryFileName,
              compiledRootFiles: Array.from(WORKSPACE_COMPILED_ROOT_FILE_EXTENSIONS).sort(),
              compiledDirectories: Array.from(WORKSPACE_COMPILED_ROOT_DIRECTORIES).sort(),
            }
          : {}),
        activeFile: isTemporaryFileTab(currentTab) ? currentTab.name : currentTab.path,
        activeFileRelativePath: activeRelativePath,
        activeFileDirty: Boolean(currentTab.isDirty),
        activeEditorHash: await sha256Hex(activeContent),
        fileHashes,
        fileCount: collectedFiles.length,
        collectedAt: new Date().toISOString(),
        ...metadata,
      },
    };
  }

  function canPrepareCloudSourceMarker() {
    return Boolean(appwriteConfig.firmwareSourceBucketId && appwriteConfig.sourceSnapshotsCollectionId);
  }

  async function prepareCloudSourceRestoreMarker(options: {
    sourceSnapshot: BoardCodeSourceSnapshotInput | null;
    identity: Record<string, unknown>;
    operation: string;
    uploadId: string;
    firmwareId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<(SourceRestoreMarker & { sourceSnapshotChecksum?: string; sourceSnapshotManifest?: Record<string, unknown>; createdAt?: string }) | null> {
    if (!options.sourceSnapshot || !canPrepareCloudSourceMarker()) {
      return null;
    }

    const result = await window.tantalum.toolchain.prepareSourceRestoreMarker({
      sourceSnapshot: options.sourceSnapshot,
      identity: options.identity,
      operation: options.operation,
      uploadId: options.uploadId,
      firmwareId: options.firmwareId,
      metadata: {
        sourceCodeVisibility: typeof options.identity.sourceCodeVisibility === 'string' ? options.identity.sourceCodeVisibility : 'private',
        ...(options.metadata || {}),
      },
    });
    if (result.success) {
      pushConsole('Cloud source restore marker saved.');
      return {
        markerId: result.markerId,
        snapshotChecksum: result.snapshotChecksum,
        sourceSnapshotFileId: result.sourceSnapshotFileId,
        sourceSnapshotChecksum: result.sourceSnapshotChecksum,
        sourceSnapshotManifest: result.sourceSnapshotManifest,
        createdAt: result.createdAt,
        retentionGroup: result.retentionGroup,
      };
    }

    const continueWithoutMarker = window.confirm(
      `Tantalum could not save the cloud source restore marker:\n\n${result.error}\n\nContinue uploading without cloud exact-restore from board firmware?`,
    );
    if (!continueWithoutMarker) {
      throw new Error(`Upload canceled because the cloud source restore marker could not be saved: ${result.error}`);
    }
    pushConsole(`Cloud source restore marker skipped: ${result.error}`, 'info');
    return null;
  }

  function isWorkspaceCompiledRootItem(item: { name: string; isDirectory: boolean }) {
    if (item.isDirectory) {
      return isWorkspaceCompiledRootDirectoryName(item.name);
    }
    return isWorkspaceCompiledRootFileName(item.name);
  }

  function mapDirectoryItemsToTreeNodes(
    items: Array<{ name: string; path: string; isDirectory: boolean; extension: string | null }>,
    options: { workspaceSketchRoot?: boolean } = {},
  ): FileTreeNode[] {
    const visibleItems = items.filter((item) => item.name !== FILE_TREE_INTERNAL_TRASH_DIR && item.name !== PROJECT_METADATA_DIRECTORY && !item.name.startsWith('.trash_'));
    const normalizedEntryFile = projectIntegrity.entryFile?.toLowerCase() ?? '';
    const conflictFileNames = new Set(projectIntegrity.conflictFiles.map((name) => name.toLowerCase()));
    const compiledRootPaths = new Set<string>();
    if (options.workspaceSketchRoot) {
      const classifications = visibleItems.map((item) => ({
        path: item.path,
        compiled: isWorkspaceCompiledRootItem(item),
      }));
      for (const classification of classifications) {
        if (classification.compiled) {
          compiledRootPaths.add(normalizeTreePath(classification.path));
        }
      }
    }
    const orderedItems = options.workspaceSketchRoot
      ? [
          ...visibleItems
            .filter((item) => compiledRootPaths.has(normalizeTreePath(item.path)))
            .sort(compareWorkspaceCompiledRootItems),
          ...visibleItems
            .filter((item) => !compiledRootPaths.has(normalizeTreePath(item.path)))
            .sort(compareWorkspaceDirectoryItems),
        ]
      : visibleItems;
    const includedCount = options.workspaceSketchRoot
      ? visibleItems.filter((item) => compiledRootPaths.has(normalizeTreePath(item.path))).length
      : 0;

    return orderedItems
      .map((item, index): WorkspaceSketchTreeNode => ({
        name: item.name,
        path: item.path,
        type: item.isDirectory ? 'directory' : 'file',
        extension: item.extension ?? undefined,
        sketchSection: options.workspaceSketchRoot && index < includedCount ? 'included' : options.workspaceSketchRoot ? 'workspace' : undefined,
        sectionBoundary: Boolean(options.workspaceSketchRoot && includedCount > 0 && index === includedCount),
        projectEntry: Boolean(options.workspaceSketchRoot && !item.isDirectory && normalizedEntryFile && item.name.toLowerCase() === normalizedEntryFile),
        lifecycleConflict: Boolean(options.workspaceSketchRoot && !item.isDirectory && conflictFileNames.has(item.name.toLowerCase())),
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
      pushConsole(`Unable to clean Project trash: ${result.error}`, 'error');
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

  async function makeProjectEntryPoint(filePath: string) {
    const rootPath = workspacePathRef.current;
    const entryFile = rootProjectFileName(filePath, rootPath);
    if (!rootPath || !entryFile || !normalizeProjectEntryFileName(entryFile)) {
      pushToast('Only root .ino files can be Project entry points.', 'error');
      return;
    }

    try {
      await writeProjectMetadata(rootPath, entryFile);
      const integrity = await refreshProjectIntegrity(rootPath);
      refreshFileTree();
      const conflicts = integrity.conflictFiles.filter((name) => name.toLowerCase() !== entryFile.toLowerCase());
      pushToast(`${entryFile} is now the Project entry point.`, 'success', undefined, conflicts.length > 0 ? {
        detail: `${conflicts.join(', ')} still defines setup() or loop().`,
      } : undefined);
      refreshActiveEditorDiagnostics(activeEditorFilePath);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to update Project entry point.', 'error');
    }
  }

  async function syncBoardSecrets(boardId: string) {
    const result = await window.tantalum.secrets.getBoardSecrets(boardId);
    if (result.success) {
      setSelectedBoardSecrets((result.secrets as BoardSecret | null) ?? null);
    }
  }

  function buildCloudRuntimeConfig(board: BoardDocument, secrets: BoardSecret, overrides: { firmwareVersion?: string; firmwareId?: string } = {}) {
    return {
      boardId: board.$id,
      boardName: board.name,
      apiToken: secrets.apiToken,
      commandSecret: secrets.commandSecret,
      mqttTopic: secrets.mqttTopic,
      provisioningPop: secrets.provisioningPop,
      appwriteEndpoint: appwriteConfig.endpoint,
      appwriteProjectId: appwriteConfig.projectId,
      deviceGatewayFunctionId: appwriteConfig.deviceGatewayFunctionId,
      firmwareVersion: overrides.firmwareVersion || board.firmwareVersion || '0.0.0',
      firmwareId: overrides.firmwareId || board.desiredFirmwareId || '',
      mqttHost: appwriteConfig.mqttHost,
      mqttPort: appwriteConfig.mqttPort,
      mqttUsername: appwriteConfig.mqttUsername,
      mqttPassword: appwriteConfig.mqttPassword,
      mqttCaCert: appwriteConfig.mqttCaCert,
      tlsCaCert: appwriteConfig.tlsCaCert,
    };
  }

  async function refreshBoardsList(options: { silent?: boolean; bypassCache?: boolean } = {}) {
    if (!hasRequiredCloudConfiguration()) {
      if (!options.silent) {
        setBoardsLoading(false);
        setBoardsError('Cloud configuration is incomplete.');
      }
      return [];
    }

    if (!options.silent) {
      setBoardsLoading(true);
    }
    setBoardsError(null);

    try {
      const nextBoards = await listBoards({ bypassCache: options.bypassCache ?? !options.silent });
      setBoards(nextBoards);

      if (!selectedBoardId && nextBoards.length > 0) {
        setSelectedBoardId(nextBoards[0].$id);
      }

      if (selectedBoardId && !nextBoards.some((board) => board.$id === selectedBoardId)) {
        setSelectedBoardId(nextBoards[0]?.$id ?? '');
      }
      return nextBoards;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load boards.';
      setBoardsError(message);
      if (!options.silent) {
        pushConsole(message, 'error');
      }
      return [];
    } finally {
      if (!options.silent) {
        setBoardsLoading(false);
      }
    }
  }

  async function waitForCloudBoardHeartbeat(boardId: string, timeoutMs = CLOUD_BOARD_HEARTBEAT_TIMEOUT_MS) {
    let remainingMs = timeoutMs;
    let announcedWait = false;

    while (remainingMs > 0) {
      const nextBoards = await refreshBoardsList({ silent: true });
      const board = nextBoards.find((entry) => entry.$id === boardId) ?? null;

      if (board && calculateBoardStatus(board.lastSeen, board.status) === 'online') {
        pushToast(`${board.name} is online in Tantalum Cloud.`, 'success');
        pushConsole(`Tantalum Cloud heartbeat received from ${board.name}.`, 'success');
        return board;
      }

      if (!announcedWait) {
        pushConsole('Waiting for the board to report its first Tantalum Cloud heartbeat...', 'info');
        announcedWait = true;
      }

      const waitMs = Math.min(CLOUD_BOARD_HEARTBEAT_POLL_MS, remainingMs);
      await sleep(waitMs);
      remainingMs -= waitMs;
    }

    await refreshBoardsList({ silent: true });
    pushConsole('WiFi was accepted over USB, but Tantalum Cloud has not received a heartbeat yet. Keep the board powered and open Serial Monitor at 115200 baud to check heartbeat errors if it stays pending.', 'info');
    return null;
  }

  async function refreshFirmware(board: BoardDocument | null) {
    if (!board) {
      setFirmwareHistory([]);
      return;
    }

    try {
      const history = await listFirmwareHistory(board.$id);
      setFirmwareHistory(history);
      setReleaseVersion(nextSemver(board.desiredVersion || board.firmwareVersion || history[0]?.version || '1.0.0'));
    } catch (error) {
      pushConsole(error instanceof Error ? error.message : 'Unable to load firmware history.', 'error');
    }
  }

  async function refreshLocalBoardProfiles(options: { apply?: boolean } = {}) {
    const result = await window.tantalum.toolchain.listLocalBoardProfiles();
    if (!result.success) {
      throw new Error(result.error);
    }

    if (options.apply !== false) {
      setLocalBoardProfiles(result.profiles);
    }
    return result.profiles;
  }

  async function refreshDetectedLocalBoards(options: { portsOnly?: boolean; probeEsp?: boolean; aiFallback?: boolean; apply?: boolean } = {}) {
    const payload = options.portsOnly || options.probeEsp || options.aiFallback
      ? {
          ...(options.portsOnly ? { portsOnly: true } : {}),
          ...(options.probeEsp ? { probeEsp: true } : {}),
          ...(options.aiFallback ? { aiFallback: true } : {}),
        }
      : undefined;
    const result = await window.tantalum.toolchain.detectLocalBoards(payload);
    if (!result.success) {
      throw new Error(result.error);
    }

    const ports = result.ports ?? result.boards.map((board) => portOptionFromBoard(board)).filter((port): port is LocalBoardPort => Boolean(port));
    if (options.apply !== false) {
      setDetectedLocalBoards(result.boards);
      setLocalBoardPorts(ports);
    }
    return { boards: result.boards, ports };
  }

  function buildResolvedLocalBoardRow(row: LocalBoardRow, detected: { boards: LocalBoardDetection[]; ports: LocalBoardPort[] }) {
    const detection = pickLocalBoardDetectionForUpload(row, detected.boards);
    const matchingPort = pickLocalBoardPortForUpload(row, detected.ports, detection);
    const resolvedPort = detection?.port || matchingPort?.path || '';
    const resolvedFqbn = firstUploadableBoardFqbn(row.fqbn, detection?.fqbn);
    const previousPort = row.port;
    const portChanged = Boolean(
      previousPort &&
        resolvedPort &&
        normalizeLocalBoardHardwareValue(previousPort) !== normalizeLocalBoardHardwareValue(resolvedPort),
    );

    return {
      ...row,
      detection: detection ?? row.detection,
      connected: Boolean(resolvedPort),
      fqbn: resolvedFqbn,
      port: resolvedPort,
      boardLabel: row.boardLabel || detection?.boardLabel || (resolvedFqbn ? getBoardOptionLabel(resolvedFqbn) : 'Local board'),
      manufacturer: detection?.manufacturer || matchingPort?.manufacturer || row.manufacturer,
      protocol: detection?.protocol || matchingPort?.protocol || row.protocol,
      protocolLabel: detection?.protocolLabel || matchingPort?.protocolLabel || row.protocolLabel,
      vendorId: detection?.vendorId ?? matchingPort?.vendorId ?? row.vendorId,
      productId: detection?.productId ?? matchingPort?.productId ?? row.productId,
      serialNumber: detection?.serialNumber ?? matchingPort?.serialNumber ?? row.serialNumber,
      pnpId: detection?.pnpId ?? matchingPort?.pnpId ?? row.pnpId,
      locationId: detection?.locationId ?? matchingPort?.locationId ?? row.locationId,
      fingerprint: detection?.fingerprint || row.fingerprint,
      confidence: detection?.confidence ?? row.confidence,
      confidenceLabel: detection?.confidenceLabel ?? row.confidenceLabel,
      detectionSource: detection?.detectionSource ?? row.detectionSource,
      matchingBoards: detection?.matchingBoards ?? row.matchingBoards,
      ai: detection?.ai ?? row.ai,
      portChanged: row.portChanged || portChanged,
      stalePort: portChanged ? previousPort : row.stalePort,
    } satisfies LocalBoardRow;
  }

  function localBoardProfileFromResolvedRow(row: LocalBoardRow, profile: LocalBoardProfile) {
    return {
      ...profile,
      name: row.name || profile.name,
      fqbn: row.fqbn || profile.fqbn,
      boardLabel: row.boardLabel || profile.boardLabel,
      port: row.port || profile.port,
      protocol: row.protocol || profile.protocol,
      protocolLabel: row.protocolLabel || profile.protocolLabel,
      manufacturer: row.manufacturer || profile.manufacturer,
      vendorId: row.vendorId ?? profile.vendorId,
      productId: row.productId ?? profile.productId,
      serialNumber: row.serialNumber ?? profile.serialNumber,
      pnpId: row.pnpId ?? profile.pnpId,
      locationId: row.locationId ?? profile.locationId,
      fingerprint: row.fingerprint || profile.fingerprint,
      confidence: row.confidence ?? profile.confidence,
      connected: row.connected,
      cloudBoardId: row.cloudBoardId || profile.cloudBoardId,
      cloudLinkedAt: row.cloudLinkedAt || profile.cloudLinkedAt,
      lastCloudProvisionedAt: row.lastCloudProvisionedAt || profile.lastCloudProvisionedAt,
      lastCloudUsbUploadAt: row.lastCloudUsbUploadAt || profile.lastCloudUsbUploadAt,
      sourceCodeVisibility: row.sourceCodeVisibility || profile.sourceCodeVisibility || 'private',
    };
  }

  async function resolveLiveLocalBoardTarget(row: LocalBoardRow, options: { saveProfile?: boolean; announcePortChange?: boolean; fullScanOnMiss?: boolean } = {}): Promise<LiveLocalBoardResolution> {
    const previousPort = row.port;
    let detected = await refreshDetectedLocalBoards({ portsOnly: true, apply: false });
    let resolvedRow = buildResolvedLocalBoardRow(row, detected);

    if (!resolvedRow.port && options.fullScanOnMiss !== false && localBoardProfileHasPossibleReconnectPort(row.profile ?? row, detected.ports)) {
      detected = await refreshDetectedLocalBoards({ probeEsp: true, apply: false });
      resolvedRow = buildResolvedLocalBoardRow(row, detected);
    }

    setDetectedLocalBoards(detected.boards);
    setLocalBoardPorts(detected.ports);

    const portChanged = Boolean(
      previousPort &&
        resolvedRow.port &&
        normalizeLocalBoardHardwareValue(previousPort) !== normalizeLocalBoardHardwareValue(resolvedRow.port),
    );
    let savedProfile: LocalBoardProfile | null = null;

    if (portChanged && row.profile && options.saveProfile !== false) {
      const saveResult = await window.tantalum.toolchain.saveLocalBoardProfile(localBoardProfileFromResolvedRow(resolvedRow, row.profile));
      if (saveResult.success) {
        savedProfile = saveResult.profile;
        setLocalBoardProfiles((current) => current.map((profile) => (profile.id === savedProfile?.id ? savedProfile : profile)));
        resolvedRow = {
          ...resolvedRow,
          profile: savedProfile,
          profileId: savedProfile.id,
          cloudBoardId: savedProfile.cloudBoardId,
          cloudLinkedAt: savedProfile.cloudLinkedAt,
          lastCloudProvisionedAt: savedProfile.lastCloudProvisionedAt,
          lastCloudUsbUploadAt: savedProfile.lastCloudUsbUploadAt,
        };
      } else {
        pushConsole(saveResult.error || 'Unable to update the saved local board port.', 'error');
      }
    }

    if (portChanged && options.announcePortChange !== false) {
      const message = `USB port changed from ${previousPort} to ${resolvedRow.port}; using ${resolvedRow.port}.`;
      pushConsole(message);
      pushToast('USB port updated.', 'info', undefined, { detail: message });
    }

    return { row: resolvedRow, previousPort, portChanged, savedProfile };
  }

  async function resolveLocalBoardUploadTarget(row: LocalBoardRow) {
    const resolution = await resolveLiveLocalBoardTarget(row, { announcePortChange: false });
    return resolution.row;
  }

  function pauseLocalBoardMonitoring() {
    localBoardMonitoringPausedRef.current = true;
    localBoardScanGenerationRef.current += 1;

    if (localBoardMonitoringResumeTimerRef.current !== null) {
      window.clearTimeout(localBoardMonitoringResumeTimerRef.current);
      localBoardMonitoringResumeTimerRef.current = null;
    }
  }

  function resumeLocalBoardMonitoringSoon(delayMs = LOCAL_BOARD_UPLOAD_SETTLE_MS) {
    if (localBoardMonitoringResumeTimerRef.current !== null) {
      window.clearTimeout(localBoardMonitoringResumeTimerRef.current);
    }

    localBoardMonitoringResumeTimerRef.current = window.setTimeout(() => {
      localBoardMonitoringResumeTimerRef.current = null;
      localBoardMonitoringPausedRef.current = false;
      void refreshLocalBoards({ silent: true });
    }, delayMs);
  }

  async function refreshLocalBoards(options: { silent?: boolean; portsOnly?: boolean } = {}) {
    if (localBoardMonitoringPausedRef.current) {
      return;
    }

    if (options.silent && localBoardAutoScanActiveRef.current) {
      return;
    }

    const scanGeneration = ++localBoardScanGenerationRef.current;
    if (!options.silent) {
      setLocalBoardsError(null);
    }

    let profilesError: unknown = null;
    let profiles: LocalBoardProfile[] = localBoardProfiles;
    try {
      profiles = await refreshLocalBoardProfiles({ apply: false });
      if (scanGeneration === localBoardScanGenerationRef.current) {
        setLocalBoardProfiles(profiles);
      }
    } catch (error) {
      profilesError = error;
    }

    try {
      const usePortsOnly = options.portsOnly ?? true;
      let detected = await refreshDetectedLocalBoards({ portsOnly: usePortsOnly, apply: false });
      if (scanGeneration !== localBoardScanGenerationRef.current) {
        return;
      }

      const portSignature = localBoardPortSetSignature(detected.ports);
      if (usePortsOnly && shouldRunLocalBoardReconnectScan(profiles, detected.boards, detected.ports)) {
        if (portSignature && portSignature !== localBoardReconnectScanSignatureRef.current) {
          try {
            detected = await refreshDetectedLocalBoards({ apply: false });
            localBoardReconnectScanSignatureRef.current = portSignature;
          } catch (error) {
            if (!options.silent) {
              pushConsole(error instanceof Error ? error.message : 'Unable to refresh Arduino board metadata.', 'error');
            }
          }
        }
      } else {
        localBoardReconnectScanSignatureRef.current = '';
      }

      if (scanGeneration !== localBoardScanGenerationRef.current) {
        return;
      }

      setDetectedLocalBoards(detected.boards);
      setLocalBoardPorts(detected.ports);
      if (profilesError) {
        const message = profilesError instanceof Error ? profilesError.message : 'Unable to load saved local board.';
        setLocalBoardsError(message);
        if (!options.silent) {
          pushConsole(message, 'error');
        }
      } else if (options.silent) {
        setLocalBoardsError(null);
      } else {
        setLocalBoardsError(null);
      }
    } catch (error) {
      if (scanGeneration !== localBoardScanGenerationRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Unable to detect local boards.';
      setDetectedLocalBoards([]);
      setLocalBoardPorts([]);
      setLocalBoardsError(message);
      if (!options.silent) {
        pushConsole(message, 'error');
      }
    }
  }

  async function loadLocalBoardCatalog() {
    if (localBoardCatalogLoading || localBoardCatalog.length > 0) {
      return;
    }

    setLocalBoardCatalogLoading(true);
    setLocalBoardCatalogError(null);
    try {
      const result = await window.tantalum.toolchain.listInstalledBoards();
      if (!result.success) {
        throw new Error(result.error);
      }

      const options = uniqueBoardOptions(
        ((result.boards as Array<Record<string, unknown>>) ?? [])
          .map(normalizeBoardOptionFromCatalog)
          .filter((option): option is LocalBoardOption => Boolean(option)),
      ).sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
      setLocalBoardCatalog(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load installed boards.';
      setLocalBoardCatalogError(message);
      pushConsole(message, 'error');
    } finally {
      setLocalBoardCatalogLoading(false);
    }
  }

  function handleToggleLocalBoardAdvanced(rowKey: string) {
    const willOpen = localBoardAdvancedOpenKey !== rowKey;
    setLocalBoardAdvancedOpenKey(willOpen ? rowKey : null);
    if (willOpen) {
      void loadLocalBoardCatalog();
    }
  }

  async function handleAutoScanLocalBoard() {
    if (isLocalUploadBusyAction(busyAction) || localBoardUploadInProgressRef.current) {
      return;
    }

    localBoardMonitoringPausedRef.current = false;
    localBoardAutoScanActiveRef.current = true;
    const scanGeneration = ++localBoardScanGenerationRef.current;
    setLocalBoardAutoScanLoading(true);
    setLocalBoardsError(null);
    try {
      const [profiles, detected] = await Promise.all([
        refreshLocalBoardProfiles({ apply: false }),
        refreshDetectedLocalBoards({ probeEsp: true, aiFallback: true, apply: false }),
      ]);
      if (scanGeneration !== localBoardScanGenerationRef.current) {
        return;
      }

      setLocalBoardProfiles(profiles);
      setDetectedLocalBoards(detected.boards);
      setLocalBoardPorts(detected.ports);

      const boards = detected.boards;
      const usedExistingProfileIds = new Set<string>();
      const replacementProfiles = boards.map((detectedBoard) => {
        const existingProfile = pickBestLocalBoardHardwareMatch(
          profiles.filter((profile) => !usedExistingProfileIds.has(profile.id)),
          detectedBoard,
          35,
        );
        if (existingProfile) {
          usedExistingProfileIds.add(existingProfile.id);
        }
        const detectedFqbn = normalizeUploadableBoardFqbn(detectedBoard.fqbn);
        return {
          id: existingProfile?.id,
          name: existingProfile?.name || '',
          fqbn: detectedFqbn,
          boardLabel: detectedBoard.boardLabel || (detectedFqbn ? getBoardOptionLabel(detectedFqbn) : 'Local board'),
          port: detectedBoard.port,
          protocol: detectedBoard.protocol,
          protocolLabel: detectedBoard.protocolLabel,
          manufacturer: detectedBoard.manufacturer,
          vendorId: detectedBoard.vendorId,
          productId: detectedBoard.productId,
          serialNumber: detectedBoard.serialNumber,
          pnpId: detectedBoard.pnpId,
          locationId: detectedBoard.locationId,
          fingerprint: detectedBoard.fingerprint,
          confidence: detectedBoard.confidence,
          connected: true,
        };
      });

      const replaceResult = await window.tantalum.toolchain.replaceLocalBoardProfiles(replacementProfiles);
      if (!replaceResult.success) {
        throw new Error(replaceResult.error);
      }

      setLocalBoardProfiles(replaceResult.profiles);
      setManualLocalBoardKeys([]);
      setLocalBoardEdits({});

      const needsReviewProfile = replaceResult.profiles.find((profile) => !isUploadableBoardFqbn(profile.fqbn));
      if (needsReviewProfile) {
        setExpandedLocalBoardKeys({ [localBoardProfileKey(needsReviewProfile.id)]: true });
      } else {
        setExpandedLocalBoardKeys({});
      }

      const nextSelectedProfile =
        replaceResult.profiles.find((profile) => profile.id === selectedLocalBoardId) ??
        replaceResult.profiles.find((profile) => Boolean(profile.connected)) ??
        replaceResult.profiles[0] ??
        null;
      setSelectedLocalBoardId(nextSelectedProfile?.id ?? '');

      if (replaceResult.profiles.length === 0) {
        pushToast('No USB boards detected.', 'error', undefined, { detail: 'Saved local boards were cleared by Auto detect.' });
      } else {
        pushToast(`Detected ${replaceResult.profiles.length} local board${replaceResult.profiles.length === 1 ? '' : 's'}.`, 'success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to detect local boards.';
      setLocalBoardsError(message);
      pushConsole(message, 'error');
    } finally {
      localBoardAutoScanActiveRef.current = false;
      setLocalBoardAutoScanLoading(false);
    }
  }

  function handleResetLocalBoardEdit(rowKey: string) {
    setLocalBoardEdits((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    setLocalBoardCatalogQuery('');
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
    const previousWorkspacePath = workspacePathRef.current;
    const maySwitchWorkspace = !previousWorkspacePath || !areSameWorkspaceEditorStoragePath(previousWorkspacePath, folderPath);
    if (maySwitchWorkspace && !confirmWorkspaceSwitch(folderPath)) {
      return false;
    }

    const result = await window.tantalum.fs.setWorkspace(folderPath);
    if (!result.success) {
      pushToast(result.error, 'error');
      return false;
    }

    const didSwitchWorkspace = !previousWorkspacePath || !areSameWorkspaceEditorStoragePath(previousWorkspacePath, result.path);
    const storedReview = readStoredAgentReview(result.path);
    const validReview = storedReview ? await validateStoredAgentReview(result.path, storedReview) : null;
    if (storedReview && !validReview) {
      writeStoredAgentReview(result.path, null);
    }

    treeTrashMap.clear();
    workspacePathRef.current = result.path;
    const loadingIntegrity: ProjectIntegrityState = {
      ...EMPTY_PROJECT_INTEGRITY,
      loading: true,
    };
    projectIntegrityRef.current = loadingIntegrity;
    setProjectIntegrity(loadingIntegrity);
    setWorkspacePath(result.path);
    setPendingAgentReview(validReview);
    void refreshAgentRestorePoints(result.path);

    if (didSwitchWorkspace) {
      const storedEditorState = readStoredWorkspaceEditorTabs(result.path);
      const restoredTabs = sanitizeRestoredEditorTabs(storedEditorState?.tabs ?? [], validReview);
      if (restoredTabs.length > 0) {
        applyEditorTabState(restoredTabs, storedEditorState?.activeTabId ?? null);
      } else {
        applyEditorTabState([], null);
      }
    }

    await refreshProjectIntegrity(result.path);
    refreshFileTree();
    void refreshGitChangeIndicator(result.path);
    pushConsole(`Opened Project: ${result.path}`, 'success');
    void clearInternalTrash(result.path);
    return true;
  }

  async function openFolderPicker() {
    const result = await window.tantalum.fs.openFolder();
    if (result.success) {
      await openWorkspace(result.path);
    }
  }

  async function promptProjectEntryFileName(rootPath: string) {
    while (true) {
      const requestedName = window.prompt('Project entry file name', WORKSPACE_MAIN_SKETCH_FILE);
      if (requestedName === null) {
        return null;
      }

      const entryFile = normalizeProjectEntryFileName(requestedName);
      if (!entryFile) {
        window.alert('Use a root .ino filename, for example main.ino. Folders and other extensions are not allowed.');
        continue;
      }

      const directory = await window.tantalum.fs.readDirectory(rootPath);
      if (!directory.success) {
        throw new Error(directory.error);
      }

      const existing = directory.items.find((item) => !item.isDirectory && item.name.toLowerCase() === entryFile.toLowerCase());
      if (existing) {
        window.alert(`${entryFile} already exists. Choose a new root .ino filename.`);
        continue;
      }

      return entryFile;
    }
  }

  async function createNewProject() {
    const folderResult = await window.tantalum.projects.pickFolder();
    if (!folderResult.success) {
      return;
    }

    const opened = await openWorkspace(folderResult.path);
    if (!opened) {
      return;
    }

    try {
      const entryFile = await promptProjectEntryFileName(folderResult.path);
      if (!entryFile) {
        return;
      }

      const createResult = await window.tantalum.fs.createFile(folderResult.path, entryFile, DEFAULT_PROJECT_ENTRY_CONTENT);
      if (!createResult.success) {
        pushToast(createResult.error, 'error');
        return;
      }

      await writeProjectMetadata(folderResult.path, entryFile);
      await refreshProjectIntegrity(folderResult.path);
      refreshFileTree();
      await openFile(createResult.path, { preview: false });
      pushToast(`Created Project entry ${entryFile}.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to create Project.', 'error');
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
      pushToast('Open a Project before adding it to My Projects.', 'info');
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

    const opened = await openWorkspace(project.path);
    if (!opened) {
      return;
    }

    await refreshProjectFolders(project.id);
    setSidebar('explorer');
  }

  async function openProjectFile(project: ProjectFolder, filePath: string, options?: { preview?: boolean }) {
    if (!project.exists) {
      pushToast('Locate this project folder before opening files.', 'info');
      return;
    }

    const opened = await openWorkspace(project.path);
    if (!opened) {
      return;
    }

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

  function createFileTreeFs(treeRoot: string | null, options: { sketchWorkspace?: boolean } = {}): FileTreeFsAdapter {
    return {
      readDirectory: async (dirPath) => {
        const result = await window.tantalum.fs.readDirectory(dirPath);
        if (!result.success) {
          throw new Error(result.error);
        }

        return mapDirectoryItemsToTreeNodes(result.items, {
          workspaceSketchRoot: Boolean(options.sketchWorkspace && treeRoot && normalizeTreePath(dirPath) === normalizeTreePath(treeRoot)),
        });
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

  const workspaceFileTreeFs = createFileTreeFs(workspacePath, { sketchWorkspace: true });
  const selectedProjectFileTreeFs = createFileTreeFs(selectedProject?.path ?? null);

  function renderWorkspaceFileTreeContextMenu(props: FileTreeContextMenuRenderProps) {
    const node = props.node;
    const canMakeEntry = Boolean(
      node
      && node.type === 'file'
      && workspacePath
      && isRootInoProjectFile(node.path, workspacePath)
      && (!projectIntegrity.entryFile || fileNameFromPath(node.path).toLowerCase() !== projectIntegrity.entryFile.toLowerCase()),
    );

    if (!canMakeEntry) {
      return renderFileTreeContextMenu(props);
    }

    const makeEntryAction = {
      id: 'make-entry-point' as FileTreeContextMenuActionId,
      label: 'Make Entry Point',
      onSelect: () => makeProjectEntryPoint(node!.path),
    } satisfies FileTreeContextMenuActionItem;

    return renderFileTreeContextMenu({
      ...props,
      groups: [[makeEntryAction], ...props.groups],
    });
  }

  function renderWorkspaceFileTreeIcon(node: FileTreeNode, iconState: FileTreeIconRenderProps) {
    const sketchNode = node as WorkspaceSketchTreeNode;
    const markerClasses = [
      'workspace-tree-node-icon',
      sketchNode.sectionBoundary ? 'workspace-tree-section-boundary' : '',
      sketchNode.sketchSection ? `workspace-tree-section-${sketchNode.sketchSection}` : '',
      sketchNode.sketchSection === 'included' && node.type === 'directory' ? 'workspace-tree-compiled-directory' : '',
      sketchNode.sketchSection === 'included' && node.type === 'file' ? 'workspace-tree-compiled-file' : '',
      sketchNode.projectEntry ? 'workspace-tree-entry-sketch' : '',
      sketchNode.lifecycleConflict ? 'workspace-tree-lifecycle-conflict' : '',
    ].filter(Boolean).join(' ');

    if (node.type === 'directory') {
      const iconUrl = getMaterialFolderIconUrl(node.name || node.path, iconState.expanded);
      return <img className={`${markerClasses} workspace-tree-folder-icon`} src={iconUrl} alt="" draggable={false} />;
    }

    const iconUrl = getMaterialFileIconUrl(node.name || node.path);
    return <img className={`${markerClasses} workspace-tree-file-icon`} src={iconUrl} alt="" draggable={false} />;
  }

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

    const rootInoName = filePath && workspacePath && isRootInoProjectFile(filePath, workspacePath)
      ? rootProjectFileName(filePath, workspacePath)
      : null;
    const integrity = projectIntegrityRef.current;
    const entryFile = integrity.entryFile;
    const isProjectEntry = Boolean(rootInoName && entryFile && rootInoName.toLowerCase() === entryFile.toLowerCase());
    const canReportLifecycleConflict = Boolean(rootInoName && !integrity.loading && !integrity.error);
    const lifecycleConflict = Boolean(
      rootInoName
      && canReportLifecycleConflict
      && hasArduinoLifecycleFunction(model.getValue())
      && (!entryFile || rootInoName.toLowerCase() !== entryFile.toLowerCase()),
    );

    updateArduinoCppDiagnostics(monaco, model, filePath, {
      projectEntry: isProjectEntry,
      lifecycleConflict,
      requireLifecycle: isProjectEntry,
    });

    const problemWidgetKey = rootInoName ? `${filePath || rootInoName}:${entryFile || ''}` : '';
    if (!lifecycleConflict) {
      if (problemWidgetKey) {
        projectProblemWidgetOpenedRef.current.delete(problemWidgetKey);
      }
      return;
    }

    if (!problemWidgetKey || projectProblemWidgetOpenedRef.current.has(problemWidgetKey)) {
      return;
    }

    projectProblemWidgetOpenedRef.current.add(problemWidgetKey);
    window.setTimeout(() => {
      const editorInstance = editorRef.current;
      if (!editorInstance || editorInstance.getModel() !== model) {
        return;
      }

      editorInstance.trigger('tantalum.project-problem', 'editor.action.marker.next', null);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditorFilePath, workspacePath]);

  async function openFile(filePath: string, options?: { preview?: boolean }) {
    const shouldPreview = options?.preview ?? true;
    const existing = tabsRef.current.find((tab) => isSameFileTabPath(tab.path, filePath));
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

    const activeReview = pendingAgentReview;
    const pendingChange =
      activeReview?.files.find((file) => isSameFileTabPath(getAgentChangeAbsolutePath(file), filePath)) ?? null;
    const nextTab = pendingChange && activeReview
      ? makeAgentPreviewTab(pendingChange, activeReview.id, null)
      : createSavedTab(filePath, result.content, { isPreview: shouldPreview });

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
      const opened = await openWorkspace(parentPath(filePath));
      if (!opened) {
        return;
      }
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

    if (tabToSave.agentPreview) {
      pushToast('Keep or revert Tantalum AI changes before saving this file.', 'info');
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
          defaultPath: workspacePath ? joinPath(workspacePath, tabToSave.name || 'untitled.txt') : tabToSave.name,
          filters: [{ name: 'Arduino Project File', extensions: ['ino', 'cpp', 'c', 'h'] }],
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

      if (workspacePath && isRootInoProjectFile(destinationPath, workspacePath)) {
        const integrity = await refreshProjectIntegrity(workspacePath);
        refreshFileTree();
        const rootName = fileNameFromPath(destinationPath).toLowerCase();
        if (integrity.conflictFiles.some((name) => name.toLowerCase() === rootName)) {
          pushToast('Only the Project entry file can define setup() or loop().', 'error', undefined, {
            detail: `${fileNameFromPath(destinationPath)} is not the current entry point.`,
          });
        }
      }

      void refreshGitChangeIndicator();
    } finally {
      saveInProgressRef.current = false;
    }
  }

  function handleEditorBoardSelectionChange(value: string) {
    setEditorBoardSelection(value);
    const parsed = parseEditorBoardValue(value);

    if (parsed.kind === 'local') {
      setSelectedLocalBoardId(parsed.id);
      return;
    }

    if (parsed.kind === 'cloud') {
      setSelectedBoardId(parsed.id);
      const board = boards.find((entry) => entry.$id === parsed.id) ?? null;
      if (board) {
        setReleaseVersion(nextSemver(board.desiredVersion || board.firmwareVersion || '1.0.0'));
      }
    }
  }

  function resolveVerifyBoard() {
    const compileBoard = selectedEditorCloudBoard?.boardType || selectedEditorLocalBoard?.fqbn || (localBoardProfiles.length === 0 && boards.length === 0 ? 'arduino:avr:uno' : '');
    if (!compileBoard) {
      pushToast('Choose a local or cloud board before verifying this Project.', 'info');
      return '';
    }

    if (!isUploadableBoardFqbn(compileBoard)) {
      const message = 'Select an exact ESP32 board type, such as ESP32-C3, before verifying. ESP32 Family Device is only a USB detection hint.';
      openConsolePanel('output');
      pushConsole(message, 'error');
      pushToast('Choose an exact board type.', 'error', undefined, { detail: 'ESP32 Family Device cannot be used for compile/upload.' });
      return '';
    }

    return compileBoard;
  }

  function collectWorkspaceToolchainDirtyFiles(rootPath: string): Array<{ path: string; content: string }> {
    const activeId = activeTabIdRef.current;
    const activeEditorContent = editorRef.current?.getValue() ?? editorValueRef.current;
    return tabsRef.current
      .map(syncFileTabDirtyState)
      .filter((tab) => !isTemporaryFileTab(tab) && isPathInsideRoot(tab.path, rootPath))
      .filter((tab) => tab.isDirty || tab.id === activeId)
      .map((tab) => ({
        path: tab.path,
        content: tab.id === activeId ? activeEditorContent : tab.content,
      }));
  }

  function getProjectBuildBlocker(integrity: ProjectIntegrityState) {
    if (integrity.error) {
      return integrity.error;
    }
    if (!integrity.entryFile) {
      if (integrity.conflictFiles.length > 1) {
        return `Choose one Project entry point. These files define setup() or loop(): ${integrity.conflictFiles.join(', ')}.`;
      }
      return 'Create a Project entry point before verifying or uploading.';
    }
    if (integrity.conflictFiles.length > 0) {
      return `Only ${integrity.entryFile} can define setup() or loop(). Remove lifecycle functions from ${integrity.conflictFiles.join(', ')} or make one of them the entry point.`;
    }
    return '';
  }

  async function ensureProjectBuildReady(sketchSource: ToolchainSketchSource) {
    if (sketchSource.kind !== 'workspace') {
      return true;
    }

    const integrity = await refreshProjectIntegrity(sketchSource.workspacePath);
    refreshFileTree();
    const blocker = getProjectBuildBlocker(integrity);
    if (!blocker) {
      sketchSource.entryFileName = integrity.entryFile || sketchSource.entryFileName;
      return true;
    }

    openConsolePanel('output');
    pushConsole(blocker, 'error');
    pushToast('Project entry point needs attention.', 'error', undefined, { detail: blocker });
    refreshActiveEditorDiagnostics(activeEditorFilePath);
    return false;
  }

  function resolveWorkspaceSketchEntryFileName(tab: FileTab | null = activeTab): string {
    void tab;
    return projectIntegrityRef.current.entryFile || WORKSPACE_MAIN_SKETCH_FILE;
  }

  function createToolchainSketchSource(): ToolchainSketchSource {
    const currentTab = activeTab;
    const currentCode = editorRef.current?.getValue() ?? editorValueRef.current;
    const activeTabInWorkspace = Boolean(currentTab && !isTemporaryFileTab(currentTab) && workspacePath && isPathInsideRoot(currentTab.path, workspacePath));

    if (workspacePath && (!currentTab || activeTabInWorkspace)) {
      return {
        kind: 'workspace',
        workspacePath,
        entryFileName: resolveWorkspaceSketchEntryFileName(currentTab),
        dirtyFiles: collectWorkspaceToolchainDirtyFiles(workspacePath),
      };
    }

    return {
      kind: 'inline',
      fileName: currentTab?.name || 'sketch.ino',
      code: currentCode,
    };
  }

  async function runVerifySketch(options: { board: string; busyAction: string; title: string; detail: string; successMessage?: string }) {
    if (!activeTab && !workspacePath) {
      return false;
    }

    if (verifyInProgressRef.current) {
      return false;
    }

    const sketchSource = createToolchainSketchSource();
    if (!(await ensureProjectBuildReady(sketchSource))) {
      return false;
    }

    verifyInProgressRef.current = true;
    setBusyAction(options.busyAction);
    openConsolePanel('output');
    const compileSubject = sketchSource.kind === 'workspace'
      ? `Project ${sketchSource.entryFileName || WORKSPACE_MAIN_SKETCH_FILE}`
      : activeTab?.name || 'current file';
    pushConsole(`Compiling ${compileSubject} for ${getBoardOptionLabel(options.board)}...`);
    const toastId = pushToast(options.title, 'info', undefined, {
      detail: options.detail,
      persistent: true,
      progress: null,
    });

    try {
      const result = await window.tantalum.toolchain.compile({
        code: editorValue,
        board: options.board,
        sketchSource,
      });

      if (!result.success) {
        pushConsole(result.error, 'error');
        finishToast(toastId, {
          message: 'Verification failed',
          detail: result.error,
          tone: 'error',
          progress: null,
        });
        return false;
      }

      pushConsole(normalizeOutput(result.output || 'Verification finished.'), 'success');
      finishToast(toastId, {
        message: options.successMessage || `Verified ${result.filename}`,
        detail: 'Project compiled successfully.',
        tone: 'success',
        progress: 100,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to verify Project.';
      pushConsole(message, 'error');
      finishToast(toastId, {
        message: 'Verification failed',
        detail: message,
        tone: 'error',
        progress: null,
      });
      return false;
    } finally {
      verifyInProgressRef.current = false;
      setBusyAction(null);
    }
  }

  function localBoardCodeTarget(row: LocalBoardRow): BoardCodeTarget {
    const label = localBoardDisplayName(row);
    return {
      label,
      board: {
        name: label,
        fqbn: row.fqbn,
        port: row.port,
        profileId: row.profileId,
        fingerprint: row.fingerprint,
        cloudBoardId: row.cloudBoardId,
        sourceCodeVisibility: row.sourceCodeVisibility || 'private',
      },
    };
  }

  function localBoardSourceIdentity(row: LocalBoardRow) {
    const linkedCloudBoard = row.cloudBoardId ? boards.find((board) => board.$id === row.cloudBoardId) ?? null : null;
    return {
      boardName: localBoardDisplayName(row),
      fqbn: row.fqbn,
      port: row.port,
      profileId: row.profileId,
      fingerprint: row.fingerprint,
      cloudBoardId: row.cloudBoardId,
      sourceCodeVisibility: linkedCloudBoard?.sourceCodeVisibility || row.sourceCodeVisibility || 'private',
    };
  }

  async function applyBoardCodeVisibility(target: BoardCodeTarget, visibility: 'private' | 'public') {
    const result = await window.tantalum.toolchain.setBoardCodeVisibility({
      visibility,
      board: target.board,
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    return result;
  }

  async function handleSetLocalBoardCodeVisibility(row: LocalBoardRow, visibility: 'private' | 'public') {
    if (!row.profileId || !row.profile) {
      pushToast('Save this local board before changing code visibility.', 'info');
      return;
    }
    const previousVisibility = row.sourceCodeVisibility || 'private';
    setBusyAction(`code-visibility:${row.key}`);
    try {
      const saveResult = await window.tantalum.toolchain.saveLocalBoardProfile({
        ...row.profile,
        sourceCodeVisibility: visibility,
      });
      if (!saveResult.success) {
        throw new Error(saveResult.error);
      }
      setLocalBoardProfiles((current) => current.map((profile) => (profile.id === saveResult.profile.id ? saveResult.profile : profile)));
      await applyBoardCodeVisibility(localBoardCodeTarget({ ...row, sourceCodeVisibility: visibility }), visibility);
      pushToast(`Board code is now ${visibility}.`, 'success');
    } catch (error) {
      await window.tantalum.toolchain.saveLocalBoardProfile({
        ...row.profile,
        sourceCodeVisibility: previousVisibility,
      }).catch(() => undefined);
      const message = error instanceof Error ? error.message : 'Unable to update board code visibility.';
      pushToast('Unable to update code visibility.', 'error', undefined, { detail: message });
      pushConsole(message, 'error');
    } finally {
      setBusyAction(null);
      await refreshLocalBoardProfiles();
    }
  }

  async function handleSetCloudBoardCodeVisibility(board: BoardDocument, visibility: 'private' | 'public') {
    setBusyAction(`code-visibility:${board.$id}`);
    try {
      await updateBoard(board.$id, {
        sourceCodeVisibility: visibility,
        updatedAt: new Date().toISOString(),
      });
      await applyBoardCodeVisibility(remoteBoardCodeTarget({ ...board, sourceCodeVisibility: visibility }, selectedBoardLinkedLocalRow), visibility);
      await refreshBoardsList({ bypassCache: true });
      pushToast(`Board code is now ${visibility}.`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update board code visibility.';
      pushToast('Unable to update code visibility.', 'error', undefined, { detail: message });
      pushConsole(message, 'error');
    } finally {
      setBusyAction(null);
    }
  }

  function remoteBoardCodeTarget(board: BoardDocument, linkedLocalRow: LocalBoardRow | null = null): BoardCodeTarget {
    return {
      label: board.name,
      board: {
        id: board.$id,
        name: board.name,
        fqbn: board.boardType,
        port: linkedLocalRow?.port || '',
        profileId: linkedLocalRow?.profileId,
        fingerprint: linkedLocalRow?.fingerprint,
        cloudBoardId: board.$id,
        sourceCodeVisibility: board.sourceCodeVisibility || 'private',
      },
    };
  }

  function formatBoardCodeSource(source: BoardCodeViewResult['source']) {
    switch (source) {
      case 'snapshot':
        return 'exact source snapshot';
      case 'local-history':
        return 'local upload source snapshot';
      case 'hardware-ai':
        return 'approximate source project from firmware evidence';
      case 'hardware-binary':
        return 'firmware dump artifacts';
      default:
        return 'extraction notes';
    }
  }

  function selectBoardCodePrimaryFile(result: BoardCodeViewResult) {
    return result.primaryFile
      ?? result.files.find((file) => /\.(ino|cpp|c|h|hpp)$/i.test(file.relativePath || file.path))
      ?? result.files.find((file) => /readme\.md$/i.test(file.relativePath || file.path))
      ?? result.files[0]
      ?? null;
  }

  function handleBoardCodeProgress(event: BoardCodeProgressEvent) {
    const toastId = boardCodeProgressToastIdsRef.current.get(event.requestId);
    if (!toastId) {
      return;
    }
    updateToast(toastId, {
      message: event.message || 'Viewing board code...',
      detail: event.phase,
      progress: event.progress,
      progressLabel: typeof event.progress === 'number' ? `${Math.round(event.progress)}%` : undefined,
      persistent: true,
      tone: 'info',
    });
  }

  function openBoardCodeDestination(target: BoardCodeTarget) {
    void handleListBoardCodeSnapshots(target);
  }

  async function openBoardCodeResult(result: BoardCodeViewResult, mode: 'current' | 'new') {
    if (mode === 'new') {
      const opened = await openWorkspace(result.workspacePath);
      if (!opened) {
        return;
      }
    } else {
      refreshFileTree();
    }

    const primaryFile = selectBoardCodePrimaryFile(result);
    if (primaryFile?.path) {
      await openFile(primaryFile.path, { preview: false });
    }
  }

  function formatBoardCodeSnapshotFlash(snapshot: BoardCodeSnapshotSummary) {
    if (snapshot.flashedVia === 'ota') {
      return 'OTA';
    }
    if (snapshot.flashedVia === 'usb') {
      return 'USB';
    }
    return 'Unknown';
  }

  function formatBoardCodeSnapshotVerification(snapshot: BoardCodeSnapshotSummary, listStatus?: string) {
    if (snapshot.markerVerifiedFromFirmware) {
      return 'Verified from board';
    }
    if (listStatus === 'available-unverified') {
      return 'Unverified snapshot';
    }
    return 'Cloud snapshot';
  }

  function formatBoardCodeSnapshotDate(value?: string) {
    if (!value) {
      return 'Not recorded';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  }

  async function handleListBoardCodeSnapshots(target: BoardCodeTarget) {
    const requestId = createToolchainTaskId('code-extraction');
    setBoardCodeSnapshotRequest({ target, result: null, loading: true, error: '' });
    const toastId = pushToast(`Finding code snapshots for ${target.label}`, 'info', undefined, {
      detail: target.board.port ? 'Reading the Tantalum source marker from firmware...' : 'Checking cloud source snapshots...',
      persistent: true,
      progress: null,
      notificationId: requestId,
    });
    boardCodeProgressToastIdsRef.current.set(requestId, toastId);
    persistToolchainNotification({
      id: requestId,
      kind: 'code-extraction',
      title: `Finding code snapshots for ${target.label}`,
      detail: 'Checking Tantalum source snapshots...',
      status: 'running',
      phase: 'start',
      progress: null,
      name: target.label,
      target: target.board.port || target.board.fqbn || target.label,
      metadata: {
        boardId: target.board.id || target.board.cloudBoardId,
        boardType: target.board.fqbn,
        port: target.board.port,
      },
    });

    setBusyAction('view-code');
    pauseLocalBoardMonitoring();
    try {
      const result = await window.tantalum.toolchain.listBoardCodeSnapshots({
        requestId,
        board: target.board,
      });
      if (!result.success) {
        setBoardCodeSnapshotRequest({ target, result: null, loading: false, error: result.error });
        finishToast(toastId, {
          message: 'Unable to find code snapshots',
          detail: result.error,
          tone: 'error',
          progress: null,
        });
        pushConsole(result.error, 'error');
        return;
      }

      setBoardCodeSnapshotRequest({ target, result, loading: false, error: '' });
      const detail = result.message || (result.snapshots.length > 0 ? `${result.snapshots.length} snapshot${result.snapshots.length === 1 ? '' : 's'} available.` : 'No restorable source snapshots found.');
      finishToast(toastId, {
        message: result.snapshots.length > 0 ? `Snapshots found for ${target.label}` : 'No code snapshot available',
        detail,
        tone: result.snapshots.length > 0 ? 'success' : 'info',
        progress: 100,
        progressLabel: '100%',
      });
      pushConsole(detail, result.snapshots.length > 0 ? 'success' : 'info');
      if (result.warnings.length > 0) {
        pushConsole(result.warnings.join('\n'), 'info');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to find board code snapshots.';
      setBoardCodeSnapshotRequest({ target, result: null, loading: false, error: message });
      finishToast(toastId, {
        message: 'Unable to find code snapshots',
        detail: message,
        tone: 'error',
        progress: null,
      });
      pushConsole(message, 'error');
    } finally {
      boardCodeProgressToastIdsRef.current.delete(requestId);
      setBusyAction(null);
      resumeLocalBoardMonitoringSoon();
    }
  }

  async function handleRestoreBoardCodeSnapshotDestination(mode: 'current' | 'new') {
    const request = boardCodeRestoreRequest;
    if (!request) {
      return;
    }
    const { target, snapshot } = request;

    let destination: { mode: 'current' | 'new'; workspacePath?: string | null; folderPath?: string | null };
    if (mode === 'current') {
      if (!workspacePath) {
        pushToast('Open a Project before restoring code into it.', 'info');
        return;
      }
      destination = { mode: 'current', workspacePath };
    } else {
      const folderResult = await window.tantalum.projects.pickFolder();
      if (!folderResult.success) {
        if (!folderResult.canceled) {
          pushToast(folderResult.error, 'error');
        }
        return;
      }
      destination = { mode: 'new', folderPath: folderResult.path };
    }

    setBoardCodeRestoreRequest(null);
    const requestId = createToolchainTaskId('code-extraction');
    const toastId = pushToast(`Restoring code for ${target.label}`, 'info', undefined, {
      detail: mode === 'new' ? 'Preparing a new Project...' : 'Preparing restore folder...',
      persistent: true,
      progress: null,
      notificationId: requestId,
    });
    boardCodeProgressToastIdsRef.current.set(requestId, toastId);
    persistToolchainNotification({
      id: requestId,
      kind: 'code-extraction',
      title: `Restoring code for ${target.label}`,
      detail: 'Downloading source snapshot...',
      status: 'running',
      phase: 'start',
      progress: null,
      name: target.label,
      target: target.board.port || target.board.fqbn || target.label,
      metadata: {
        boardId: target.board.id || target.board.cloudBoardId,
        boardType: target.board.fqbn,
        port: target.board.port,
      },
    });

    setBusyAction('view-code');
    try {
      const result = await window.tantalum.toolchain.restoreBoardCodeSnapshot({
        requestId,
        markerId: snapshot.markerId,
        markerVerifiedFromFirmware: request.markerVerifiedFromFirmware,
        destination,
        board: target.board,
      });
      if (!result.success) {
        finishToast(toastId, {
          message: 'Unable to restore board code',
          detail: result.error,
          tone: 'error',
          progress: null,
        });
        pushConsole(result.error, 'error');
        return;
      }

      await openBoardCodeResult(result, mode);
      const detail = `${formatBoardCodeSource(result.source)} written to ${result.outputPath || result.workspacePath}.`;
      finishToast(toastId, {
        message: `Code restored for ${target.label}`,
        detail,
        tone: 'success',
        progress: 100,
        progressLabel: '100%',
      });
      pushConsole(detail, 'success');
      if (result.warnings.length > 0) {
        pushConsole(result.warnings.join('\n'), 'info');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to restore board code.';
      finishToast(toastId, {
        message: 'Unable to restore board code',
        detail: message,
        tone: 'error',
        progress: null,
      });
      pushConsole(message, 'error');
    } finally {
      boardCodeProgressToastIdsRef.current.delete(requestId);
      setBusyAction(null);
    }
  }

  async function handleCompile() {
    if (!activeTab && !workspacePath) {
      return;
    }

    if (verifyInProgressRef.current || localBoardUploadInProgressRef.current) {
      return;
    }

    const compileBoard = resolveVerifyBoard();
    if (!compileBoard) {
      return;
    }

    await runVerifySketch({
      board: compileBoard,
      busyAction: 'compile',
      title: `Verifying ${activeTab?.name || projectIntegrity.entryFile || 'Project'}`,
      detail: `Compiling for ${getBoardOptionLabel(compileBoard)}...`,
    });
  }

  async function handleUploadLocal(targetLocalBoard: LocalBoardRow | null = selectedEditorLocalBoard ?? selectedLocalBoard) {
    if (!activeTab && !workspacePath) {
      return;
    }

    if (localBoardUploadInProgressRef.current || verifyInProgressRef.current) {
      return;
    }

    localBoardUploadInProgressRef.current = true;
    try {
    if (!targetLocalBoard?.fqbn || !targetLocalBoard.port) {
      pushToast('Choose a local board with a board type and port before uploading.', 'info');
      return;
    }

    if (!isUploadableBoardFqbn(targetLocalBoard.fqbn)) {
      const message = 'Select an exact ESP32 board type, such as ESP32-C3, before uploading. ESP32 Family Device is only a USB detection hint.';
      openConsolePanel('output');
      pushConsole(message, 'error');
      pushToast('Choose an exact board type.', 'error', undefined, { detail: 'ESP32 Family Device cannot be used for compile/upload.' });
      return;
    }

    let boardName = localBoardDisplayName(targetLocalBoard);
    if (uiPreferences.verifyBeforeUpload) {
      const verified = await runVerifySketch({
        board: targetLocalBoard.fqbn,
        busyAction: 'verify-before-upload',
        title: `Verifying ${activeTab?.name || projectIntegrity.entryFile || 'Project'}`,
        detail: `Checking ${activeTab?.name || projectIntegrity.entryFile || 'Project'} before uploading to ${boardName}...`,
        successMessage: 'Verification passed',
      });

      if (!verified) {
        return;
      }
    }

    setBusyAction('prepare-upload');
    openConsolePanel('output');
    pushConsole(`Preparing USB upload for ${activeTab?.name || projectIntegrity.entryFile || 'Project'}...`);

    let uploadBoard: LocalBoardRow;
    try {
      const uploadResolution = await resolveLiveLocalBoardTarget(targetLocalBoard);
      uploadBoard = uploadResolution.row;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh local board ports before uploading.';
      openConsolePanel('output');
      pushConsole(message, 'error');
      pushToast('Unable to refresh local board.', 'error', undefined, { detail: message });
      return;
    }

    if (!canUploadLocalBoard(uploadBoard)) {
      const message = `${localBoardDisplayName(uploadBoard)} is not available on ${targetLocalBoard.port}. ESP boards can change COM ports during reset; reconnect the board or run Auto scan, then try Upload again.`;
      openConsolePanel('output');
      pushConsole(message, 'error');
      pushToast('Local board unavailable.', 'error', undefined, { detail: message });
      return;
    }

    boardName = localBoardDisplayName(uploadBoard);
    try {
      const previousPort = uploadBoard.port;
      uploadBoard = await resolveLocalBoardUploadTarget(uploadBoard);
      if (!canUploadLocalBoard(uploadBoard)) {
        const message = `${localBoardDisplayName(uploadBoard)} is no longer available on ${previousPort || targetLocalBoard.port}. Reconnect the board or run Auto scan, then try Upload again.`;
        openConsolePanel('output');
        pushConsole(message, 'error');
        pushToast('Local board unavailable.', 'error', undefined, { detail: message });
        return;
      }

      if (previousPort && uploadBoard.port !== previousPort) {
        const message = `Upload port changed from ${previousPort} to ${uploadBoard.port}; using the live port.`;
        pushConsole(message);
        pushToast('Upload port updated.', 'info', undefined, { detail: message });
      }
      boardName = localBoardDisplayName(uploadBoard);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh local board ports before uploading.';
      openConsolePanel('output');
      pushConsole(message, 'error');
      pushToast('Unable to refresh local board.', 'error', undefined, { detail: message });
      return;
    }

    if (!uploadBoard.cloudBoardId && isCloudCapableBoardFqbn(uploadBoard.fqbn)) {
      const likelyCloudBoard = findLikelyCloudBoardForLocal(uploadBoard, boards, selectedBoardId);
      if (likelyCloudBoard) {
        const choice = window.prompt(
          `${localBoardDisplayName(uploadBoard)} looks like cloud board "${likelyCloudBoard.name}".\n\nType LINK to link it and keep OTA/runtime during this USB upload.\nType PLAIN to continue as a plain local upload, which can remove OTA/runtime from the board.\nCancel to stop.`,
          'LINK',
        );

        if (!choice) {
          pushToast('USB upload cancelled.', 'info');
          return;
        }

        const normalizedChoice = choice.trim().toUpperCase();
        if (normalizedChoice === 'LINK') {
          const linkedProfile = await linkLocalBoardToCloud(uploadBoard, likelyCloudBoard, { quiet: true });
          if (!linkedProfile) {
            pushToast('USB upload cancelled.', 'info');
            return;
          }

          uploadBoard = {
            ...uploadBoard,
            profile: linkedProfile,
            profileId: linkedProfile.id,
            cloudBoardId: likelyCloudBoard.$id,
            cloudLinkedAt: linkedProfile.cloudLinkedAt,
            lastCloudProvisionedAt: linkedProfile.lastCloudProvisionedAt,
            lastCloudUsbUploadAt: linkedProfile.lastCloudUsbUploadAt,
          };
          pushToast(`${localBoardDisplayName(uploadBoard)} linked to ${likelyCloudBoard.name}.`, 'success');
          pushConsole(`Linked ${localBoardDisplayName(uploadBoard)} to cloud board ${likelyCloudBoard.name}; USB upload will keep the Tantalum cloud runtime.`, 'success');
        } else if (normalizedChoice === 'PLAIN') {
          pushToast('Continuing plain local upload.', 'info', undefined, { detail: 'This can remove OTA/runtime from the board.' });
          pushConsole('Continuing as a plain local upload. If this is a cloud board, the Tantalum runtime and OTA support can be removed.', 'info');
        } else {
          pushToast('USB upload cancelled.', 'info');
          return;
        }
      }
    }

    let linkedCloudRuntime: Record<string, unknown> | null = null;
    if (uploadBoard.cloudBoardId) {
      const linkedBoard = boards.find((board) => board.$id === uploadBoard.cloudBoardId) ?? null;
      if (!linkedBoard) {
        const message = 'This local board is linked to a cloud board that is not available in the current board list.';
        openConsolePanel('output');
        pushConsole(message, 'error');
        pushToast('Linked cloud board unavailable.', 'error', undefined, { detail: message });
        return;
      }

      const secretResult = await window.tantalum.secrets.getBoardSecrets(linkedBoard.$id);
      if (!secretResult.success || !secretResult.secrets?.apiToken || !secretResult.secrets.commandSecret || !secretResult.secrets.mqttTopic || !secretResult.secrets.provisioningPop) {
        const message = 'Local cloud-board secrets are missing. Rotate the cloud board token, then install Tantalum Cloud again.';
        openConsolePanel('output');
        pushConsole(message, 'error');
        pushToast('Cloud runtime secrets missing.', 'error', undefined, { detail: message });
        return;
      }

      linkedCloudRuntime = buildCloudRuntimeConfig(linkedBoard, secretResult.secrets as BoardSecret, {
        firmwareVersion: linkedBoard.firmwareVersion || '0.0.0',
        firmwareId: linkedBoard.desiredFirmwareId || '',
      });
    }

    const notificationId = createToolchainTaskId('usb-upload');
    const sketchSource = createToolchainSketchSource();
    if (!(await ensureProjectBuildReady(sketchSource))) {
      return;
    }
    const uploadSubject = sketchSource.kind === 'workspace'
      ? `Project ${sketchSource.entryFileName || WORKSPACE_MAIN_SKETCH_FILE}`
      : activeTab?.name || 'current file';
    const uploadFileName = activeTab?.name || (sketchSource.kind === 'workspace' ? sketchSource.entryFileName || WORKSPACE_MAIN_SKETCH_FILE : 'current file');
    persistToolchainNotification({
      id: notificationId,
      kind: 'usb-upload',
      title: `Uploading to ${boardName}`,
      detail: `Uploading ${uploadSubject} on ${uploadBoard.port}...`,
      status: 'running',
      phase: 'upload',
      progress: null,
      name: boardName,
      target: uploadBoard.port,
      metadata: {
        board: uploadBoard.fqbn,
        port: uploadBoard.port,
        fileName: uploadFileName,
      },
    });
    const toastId = pushToast(`Uploading to ${boardName}`, 'info', undefined, {
      detail: `Uploading ${uploadSubject} on ${uploadBoard.port}...`,
      persistent: true,
      progress: null,
      notificationId,
    });
    localBoardUploadProgressRef.current = {
      uploadId: notificationId,
      toastId,
      notificationId,
      lineBuffer: '',
      lastProgress: null,
      notificationKind: 'usb-upload',
      notificationTitle: `Uploading to ${boardName}`,
      notificationName: boardName,
      notificationTarget: uploadBoard.port,
      notificationPhase: 'upload',
      notificationMetadata: {
        board: uploadBoard.fqbn,
        port: uploadBoard.port,
        fileName: uploadFileName,
      },
      progressMode: 'usb-upload',
    };

    pauseLocalBoardMonitoring();
    setBusyAction('upload-local');
    openConsolePanel('output');
    pushConsole(`Uploading ${uploadSubject} to ${boardName} on ${uploadBoard.port}...`);

    let sourceSnapshot: BoardCodeSourceSnapshotInput | null = null;
    let sourceRestoreMarker: SourceRestoreMarker | null = null;
    const sourceSnapshotsEnabled = uiPreferences.sourceSnapshotsEnabled !== false;
    if (sourceSnapshotsEnabled) {
      try {
        sourceSnapshot = await buildBoardCodeSourceSnapshot(boardName, {
          operation: 'usb-upload',
          boardType: uploadBoard.fqbn,
          port: uploadBoard.port,
          profileId: uploadBoard.profileId,
          cloudBoardId: uploadBoard.cloudBoardId,
          uploadId: notificationId,
          sourceCodeVisibility: localBoardSourceIdentity(uploadBoard).sourceCodeVisibility,
          flashedVia: 'usb',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to prepare source snapshot for upload history.';
        pushConsole(`Source snapshot skipped: ${message}`, 'info');
      }
    } else {
      pushConsole('Source snapshots are disabled in Settings; exact View Code restore will not be available for this upload.', 'info');
    }

    let result;
    try {
      if (sourceSnapshotsEnabled) {
        sourceRestoreMarker = await prepareCloudSourceRestoreMarker({
          sourceSnapshot,
          identity: localBoardSourceIdentity(uploadBoard),
          operation: 'usb-upload',
          uploadId: notificationId,
        });
      }
      result = await window.tantalum.toolchain.uploadLocalSketch({
        code: editorValue,
        board: uploadBoard.fqbn,
        port: uploadBoard.port,
        sketchSource,
        uploadId: notificationId,
        cloudRuntime: linkedCloudRuntime,
        ...(sourceRestoreMarker ? { sourceRestoreMarker } : {}),
        ...(sourceSnapshot ? { sourceSnapshot, sourceIdentity: localBoardSourceIdentity(uploadBoard) } : {}),
      });

      if (!result.success && isLocalBoardUploadRecoverableSerialError(result.error)) {
        const retryBoard = await resolveLocalBoardUploadTarget(uploadBoard);
        if (retryBoard.port && retryBoard.port !== uploadBoard.port && canUploadLocalBoard(retryBoard)) {
          const retryMessage = `Upload port changed from ${uploadBoard.port} to ${retryBoard.port}; retrying once.`;
          uploadBoard = retryBoard;
          boardName = localBoardDisplayName(uploadBoard);
          pushConsole(retryMessage);
          persistToolchainNotification({
            id: notificationId,
            kind: 'usb-upload',
            title: `Retrying upload to ${boardName}`,
            detail: retryMessage,
            status: 'running',
            phase: 'upload',
            progress: null,
            name: boardName,
            target: uploadBoard.port,
            metadata: {
              board: uploadBoard.fqbn,
              port: uploadBoard.port,
              fileName: uploadFileName,
            },
          });
          updateToast(toastId, {
            message: `Retrying upload to ${boardName}`,
            detail: retryMessage,
            tone: 'info',
            progress: null,
          });
          if (localBoardUploadProgressRef.current?.uploadId === notificationId) {
            localBoardUploadProgressRef.current = {
              ...localBoardUploadProgressRef.current,
              notificationTitle: `Retrying upload to ${boardName}`,
              notificationName: boardName,
              notificationTarget: uploadBoard.port,
              notificationMetadata: {
                board: uploadBoard.fqbn,
                port: uploadBoard.port,
                fileName: uploadFileName,
              },
            };
          }
          if (sourceSnapshotsEnabled) {
            sourceRestoreMarker = await prepareCloudSourceRestoreMarker({
              sourceSnapshot,
              identity: localBoardSourceIdentity(uploadBoard),
              operation: 'usb-upload',
              uploadId: notificationId,
            });
          }
          result = await window.tantalum.toolchain.uploadLocalSketch({
            code: editorValue,
            board: uploadBoard.fqbn,
            port: uploadBoard.port,
            sketchSource,
            uploadId: notificationId,
            cloudRuntime: linkedCloudRuntime,
            ...(sourceRestoreMarker ? { sourceRestoreMarker } : {}),
            ...(sourceSnapshot ? { sourceSnapshot, sourceIdentity: localBoardSourceIdentity(uploadBoard) } : {}),
          });
        }
      }
    } catch (error) {
      result = {
        success: false as const,
        error: error instanceof Error ? error.message : 'Unable to upload Project.',
      };
    } finally {
      if (sourceRestoreMarker && result && !result.success) {
        await window.tantalum.toolchain.discardSourceRestoreMarker({ sourceRestoreMarker }).catch(() => undefined);
      }
      if (localBoardUploadProgressRef.current?.uploadId === notificationId) {
        const bufferedLine = localBoardUploadProgressRef.current.lineBuffer.trim();
        if (bufferedLine) {
          pushConsole(bufferedLine, 'info');
        }
        localBoardUploadProgressRef.current = null;
      }
      setBusyAction(null);
      resumeLocalBoardMonitoringSoon();
    }

    if (!result.success) {
      const blockerActions: Toast['actions'] | undefined = isLocalBoardUploadRecoverableSerialError(result.error) && uploadBoard.port
        ? [{
            label: 'Find blockers',
            dismissOnSelect: false,
            onSelect: () => {
              setSerialBlockerDialog({
                port: uploadBoard.port,
                title: 'USB upload blockers',
                subtitle: `Checking ${uploadBoard.port} before retrying upload to ${boardName}.`,
                retryLabel: 'Retry upload',
                onRetry: () => {
                  setSerialBlockerDialog(null);
                  void handleUploadLocal(uploadBoard);
                },
              });
            },
          }]
        : undefined;
      pushConsole(result.error, 'error');
      persistToolchainNotification({
        id: notificationId,
        kind: 'usb-upload',
        title: 'USB upload failed',
        detail: result.error,
        status: 'error',
        phase: 'error',
        progress: null,
        name: boardName,
        target: uploadBoard.port,
        metadata: {
          board: uploadBoard.fqbn,
          port: uploadBoard.port,
          fileName: uploadFileName,
        },
      });
      if (blockerActions) {
        updateToast(toastId, {
          message: 'USB upload failed',
          detail: result.error,
          tone: 'error',
          progress: null,
          persistent: true,
          actions: blockerActions,
        });
      } else {
        finishToast(toastId, {
          message: 'USB upload failed',
          detail: result.error,
          tone: 'error',
          progress: null,
        });
      }
      return;
    }

    if (linkedCloudRuntime && uploadBoard.profile) {
      const saveResult = await window.tantalum.toolchain.saveLocalBoardProfile({
        ...uploadBoard.profile,
        lastCloudUsbUploadAt: new Date().toISOString(),
      });
      if (saveResult.success) {
        await refreshLocalBoardProfiles();
      }
    }

    const sourceRestoreDetail = sourceRestoreMarker && result.sourceRestoreMarkerEmbedded
      ? 'Source restore marker embedded for View Code.'
      : sourceSnapshotsEnabled
        ? 'No firmware source marker was embedded; View Code may only show existing or unverified snapshots.'
        : 'Source snapshots were disabled; View Code restore will not be available for this upload.';
    const uploadSuccessDetail = [result.message || 'Upload finished.', sourceRestoreDetail].filter(Boolean).join(' ');
    pushConsole(uploadSuccessDetail, 'success');
    persistToolchainNotification({
      id: notificationId,
      kind: 'usb-upload',
      title: `Uploaded to ${boardName}`,
      detail: uploadSuccessDetail,
      status: 'success',
      phase: 'complete',
      progress: 100,
      name: boardName,
      target: uploadBoard.port,
      metadata: {
        board: uploadBoard.fqbn,
        port: uploadBoard.port,
        fileName: uploadFileName,
      },
    });
    finishToast(toastId, {
      message: `Uploaded to ${boardName}`,
      detail: uploadSuccessDetail,
      tone: 'success',
      progress: 100,
    });
    } finally {
      setBusyAction(null);
      localBoardUploadInProgressRef.current = false;
    }
  }

  async function handleUploadRelease(targetBoard: BoardDocument | null = selectedBoard) {
    if (!targetBoard) {
      pushToast('Choose a board before uploading firmware.', 'info');
      return;
    }

    if (!releaseVersion.match(/^\d+\.\d+\.\d+$/)) {
      pushToast('Use semantic versioning like 1.0.1.', 'error');
      return;
    }

    if (targetBoard.$id !== selectedBoardId) {
      setSelectedBoardId(targetBoard.$id);
    }

    const sketchSource = createToolchainSketchSource();
    if (!(await ensureProjectBuildReady(sketchSource))) {
      return;
    }

    const boardName = targetBoard.name;
    const notificationId = createToolchainTaskId('firmware-upload');
    const firmwareId = `fw_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const deploymentId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const uploadProgressId = `${notificationId}:storage`;
    const initialProgress = FIRMWARE_RELEASE_PHASE_CONFIG.prepare.start;
    const initialDetail = FIRMWARE_RELEASE_PHASE_CONFIG.prepare.fallbackDetail;
    const startedAt = currentTimestampMs();
    persistToolchainNotification({
      id: notificationId,
      kind: 'firmware-upload',
      title: `Building ${boardName} ${releaseVersion}`,
      detail: initialDetail,
      status: 'running',
      phase: 'prepare',
      progress: initialProgress,
      name: boardName,
      version: releaseVersion,
      target: boardName,
      metadata: {
        boardId: targetBoard.$id,
        boardType: targetBoard.boardType,
      },
    });
    const toastId = pushToast(`Building ${boardName} ${releaseVersion}`, 'info', undefined, {
      detail: initialDetail,
      persistent: true,
      progress: initialProgress,
      notificationId,
    });
    startFirmwareReleaseProgressTask({
      notificationId,
      toastId,
      boardName,
      boardId: targetBoard.$id,
      boardType: targetBoard.boardType,
      version: releaseVersion,
      startedAt,
      phaseStartedAt: startedAt,
      phase: 'prepare',
      detail: initialDetail,
      progress: initialProgress,
      compileEventCount: 0,
      uploadProgressId,
    });

    setBusyAction('upload');
    pushConsole(`Building ${targetBoard.name} firmware release ${releaseVersion}...`);

    let releaseSourceSnapshotInput: BoardCodeSourceSnapshotInput | null = null;
    const sourceSnapshotsEnabled = uiPreferences.sourceSnapshotsEnabled !== false;
    if (sourceSnapshotsEnabled) {
      try {
        releaseSourceSnapshotInput = await buildBoardCodeSourceSnapshot(boardName, {
          operation: 'firmware-release',
          boardId: targetBoard.$id,
          cloudBoardId: targetBoard.$id,
          boardType: targetBoard.boardType,
          firmwareId,
          version: releaseVersion,
          uploadId: notificationId,
          sourceCodeVisibility: targetBoard.sourceCodeVisibility || 'private',
          flashedVia: 'ota',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to prepare source snapshot.';
        pushConsole(`Source snapshot skipped: ${message}`, 'info');
      }
    } else {
      pushConsole('Source snapshots are disabled in Settings; exact View Code restore will not be available for this firmware release.', 'info');
    }

    const secretResult = await window.tantalum.secrets.getBoardSecrets(targetBoard.$id);
    if (!secretResult.success || !secretResult.secrets?.apiToken || !secretResult.secrets?.commandSecret || !secretResult.secrets?.mqttTopic || !secretResult.secrets?.provisioningPop) {
      setBusyAction(null);
      const message = 'Local board secrets are missing. Rotate the board token, then install Tantalum Cloud again.';
      pushConsole(message, 'error');
      const failedProgressTask = finishFirmwareReleaseProgressTask(notificationId, {
        detail: message,
      }, 'error');
      finishToast(toastId, {
        message: 'Cloud runtime secrets are missing.',
        detail: message,
        tone: 'error',
        progress: failedProgressTask?.progress ?? initialProgress,
      });
      return;
    }

    let releaseSourceRestoreMarker: (SourceRestoreMarker & { sourceSnapshotChecksum?: string; sourceSnapshotManifest?: Record<string, unknown>; createdAt?: string }) | null = null;
    if (sourceSnapshotsEnabled) {
      try {
        releaseSourceRestoreMarker = await prepareCloudSourceRestoreMarker({
          sourceSnapshot: releaseSourceSnapshotInput,
          identity: {
            boardName,
            fqbn: targetBoard.boardType,
            boardType: targetBoard.boardType,
            cloudBoardId: targetBoard.$id,
            sourceCodeVisibility: targetBoard.sourceCodeVisibility || 'private',
          },
          operation: 'firmware-release',
          uploadId: notificationId,
          firmwareId,
          metadata: {
            boardId: targetBoard.$id,
            boardName,
            boardType: targetBoard.boardType,
            firmwareId,
            version: releaseVersion,
            sourceCodeVisibility: targetBoard.sourceCodeVisibility || 'private',
            flashedVia: 'ota',
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to prepare cloud source restore marker.';
        setBusyAction(null);
        pushConsole(message, 'error');
        const failedProgressTask = finishFirmwareReleaseProgressTask(notificationId, {
          detail: message,
        }, 'error');
        finishToast(toastId, {
          message: 'Firmware upload canceled.',
          detail: message,
          tone: 'error',
          progress: failedProgressTask?.progress ?? initialProgress,
        });
        return;
      }
    }

    let compileResult;
    try {
      updateFirmwareReleaseProgress(notificationId, {
        phase: 'compile',
        detail: FIRMWARE_RELEASE_PHASE_CONFIG.compile.fallbackDetail,
        progress: FIRMWARE_RELEASE_PHASE_CONFIG.compile.start,
      });
      compileResult = await window.tantalum.toolchain.compile({
        code: editorValue,
        board: targetBoard.boardType,
        compileId: notificationId,
        sketchSource,
        sourceRestoreMarker: releaseSourceRestoreMarker,
        cloudRuntime: {
          boardId: targetBoard.$id,
          boardName: targetBoard.name,
          apiToken: secretResult.secrets.apiToken,
          commandSecret: secretResult.secrets.commandSecret,
          mqttTopic: secretResult.secrets.mqttTopic,
          provisioningPop: secretResult.secrets.provisioningPop,
          firmwareId,
          firmwareVersion: releaseVersion,
          appwriteEndpoint: appwriteConfig.endpoint,
          appwriteProjectId: appwriteConfig.projectId,
          deviceGatewayFunctionId: appwriteConfig.deviceGatewayFunctionId,
          mqttHost: appwriteConfig.mqttHost,
          mqttPort: appwriteConfig.mqttPort,
          mqttUsername: appwriteConfig.mqttUsername,
          mqttPassword: appwriteConfig.mqttPassword,
          mqttCaCert: appwriteConfig.mqttCaCert,
          tlsCaCert: appwriteConfig.tlsCaCert,
        },
      });
    } catch (error) {
      compileResult = {
        success: false as const,
        error: error instanceof Error ? error.message : 'Firmware build failed.',
      };
    }

    if (!compileResult.success) {
      if (releaseSourceRestoreMarker) {
        await window.tantalum.toolchain.discardSourceRestoreMarker({ sourceRestoreMarker: releaseSourceRestoreMarker }).catch(() => undefined);
      }
      setBusyAction(null);
      pushConsole(compileResult.error, 'error');
      const failedProgressTask = finishFirmwareReleaseProgressTask(notificationId, {
        detail: compileResult.error,
      }, 'error');
      persistToolchainNotification({
        id: notificationId,
        kind: 'firmware-upload',
        title: `Failed to build ${boardName} ${releaseVersion}`,
        detail: compileResult.error,
        status: 'error',
        phase: 'compile-error',
        progress: failedProgressTask?.progress ?? null,
        name: boardName,
        version: releaseVersion,
        target: boardName,
        metadata: {
          boardId: targetBoard.$id,
          boardType: targetBoard.boardType,
        },
      });
      finishToast(toastId, {
        message: 'Compilation failed before upload.',
        detail: compileResult.error,
        tone: 'error',
        progress: failedProgressTask?.progress ?? null,
      });
      return;
    }

    const releaseSourceRestoreDetail = releaseSourceRestoreMarker && compileResult.sourceRestoreMarkerEmbedded
      ? 'Source restore marker embedded for View Code.'
      : sourceSnapshotsEnabled
        ? 'No firmware source marker was embedded; View Code may only show existing or unverified snapshots.'
        : 'Source snapshots were disabled; View Code restore will not be available for this firmware release.';
    pushConsole(`Build complete: ${compileResult.filename} (${formatBytes(compileResult.binSize)}). ${releaseSourceRestoreDetail}`, 'success');
    updateFirmwareReleaseProgress(notificationId, {
      phase: 'checksum',
      detail: FIRMWARE_RELEASE_PHASE_CONFIG.checksum.fallbackDetail,
      filename: compileResult.filename,
      progress: FIRMWARE_RELEASE_PHASE_CONFIG.checksum.start,
    });

    try {
      persistToolchainNotification({
        id: notificationId,
        kind: 'firmware-upload',
        title: `Uploading ${boardName} ${releaseVersion}`,
        detail: FIRMWARE_RELEASE_PHASE_CONFIG.checksum.fallbackDetail,
        status: 'running',
        phase: 'checksum',
        progress: FIRMWARE_RELEASE_PHASE_CONFIG.checksum.start,
        name: boardName,
        version: releaseVersion,
        target: boardName,
        metadata: {
          boardId: targetBoard.$id,
          boardType: targetBoard.boardType,
          filename: compileResult.filename,
        },
      });
      updateToast(toastId, {
        message: `Uploading ${boardName} ${releaseVersion}`,
        detail: FIRMWARE_RELEASE_PHASE_CONFIG.checksum.fallbackDetail,
        tone: 'info',
        persistent: true,
        progress: FIRMWARE_RELEASE_PHASE_CONFIG.checksum.start,
      });
      pushConsole('Calculating firmware checksum...');
      const checksum = await sha256Hex(compileResult.binData);
      let uploadedSourceSnapshot: {
        fileId: string;
        checksum: string;
        manifest: Record<string, unknown>;
        createdAt: string;
      } | null = null;
      if (releaseSourceRestoreMarker?.sourceSnapshotFileId) {
        uploadedSourceSnapshot = {
          fileId: releaseSourceRestoreMarker.sourceSnapshotFileId,
          checksum: releaseSourceRestoreMarker.sourceSnapshotChecksum || releaseSourceRestoreMarker.snapshotChecksum,
          manifest: releaseSourceRestoreMarker.sourceSnapshotManifest || {},
          createdAt: releaseSourceRestoreMarker.createdAt || new Date().toISOString(),
        };
      } else if (releaseSourceSnapshotInput && appwriteConfig.firmwareSourceBucketId) {
        pushConsole('Saving firmware source snapshot...');
        const snapshotResult = await window.tantalum.toolchain.createSourceSnapshot({
          sourceSnapshot: releaseSourceSnapshotInput,
          metadata: {
            boardId: targetBoard.$id,
            boardName,
            boardType: targetBoard.boardType,
            firmwareId,
            version: releaseVersion,
          },
        });
        if (snapshotResult.success) {
          uploadedSourceSnapshot = {
            fileId: snapshotResult.fileId,
            checksum: snapshotResult.checksum,
            manifest: snapshotResult.manifest,
            createdAt: snapshotResult.createdAt,
          };
        } else {
          pushConsole(`Source snapshot skipped: ${snapshotResult.error}`, 'info');
        }
      }
      updateFirmwareReleaseProgress(notificationId, {
        phase: 'storage',
        detail: FIRMWARE_RELEASE_PHASE_CONFIG.storage.fallbackDetail,
        progress: FIRMWARE_RELEASE_PHASE_CONFIG.storage.start,
      });
      pushConsole('Uploading firmware binary to Tantalum Cloud storage...');
      await uploadFirmwareRelease({
        user,
        board: targetBoard,
        firmwareId,
        deploymentId,
        progressId: uploadProgressId,
        version: releaseVersion,
        notes: releaseNotes,
        checksum,
        sourceSnapshot: uploadedSourceSnapshot,
        compileResult: {
          filename: compileResult.filename,
          binData: compileResult.binData,
          binSize: compileResult.binSize,
        },
      });
      if (releaseSourceRestoreMarker) {
        const promoteResult = await window.tantalum.toolchain.promoteSourceRestoreMarker({
          sourceRestoreMarker: releaseSourceRestoreMarker,
          firmwareId,
        });
        if (!promoteResult.success) {
          pushConsole(`Source restore marker promotion failed: ${promoteResult.error}`, 'info');
        }
      }

      updateFirmwareReleaseProgress(notificationId, {
        phase: 'queue',
        detail: 'Refreshing board firmware state...',
        progress: 96,
      });
      await refreshBoardsList();
      await refreshFirmware(targetBoard);
      setReleaseModalOpen(false);
      setReleaseNotes('');
      setReleaseVersion(nextSemver(releaseVersion));
      const releaseUploadDetail = `Firmware uploaded to Appwrite storage and queued for OTA deployment. ${releaseSourceRestoreDetail}`;
      persistToolchainNotification({
        id: notificationId,
        kind: 'firmware-upload',
        title: `Uploaded ${boardName} ${releaseVersion}`,
        detail: releaseUploadDetail,
        status: 'success',
        phase: 'complete',
        progress: 100,
        name: boardName,
        version: releaseVersion,
        target: boardName,
        metadata: {
          boardId: targetBoard.$id,
          boardType: targetBoard.boardType,
          filename: compileResult.filename,
        },
      });
      finishFirmwareReleaseProgressTask(notificationId, {
        phase: 'complete',
        detail: releaseUploadDetail,
        progress: 100,
      }, 'success');
      finishToast(toastId, {
        message: `Release ${releaseVersion} uploaded for ${boardName}`,
        detail: releaseUploadDetail,
        tone: 'success',
        progress: 100,
        progressLabel: '100%',
      });
      pushConsole(releaseUploadDetail, 'success');
    } catch (error) {
      if (releaseSourceRestoreMarker) {
        await window.tantalum.toolchain.discardSourceRestoreMarker({ sourceRestoreMarker: releaseSourceRestoreMarker }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : 'Firmware upload failed.';
      pushConsole(message, 'error');
      pushToast('Firmware upload failed.', 'error', undefined, { detail: message });
      const failedProgressTask = finishFirmwareReleaseProgressTask(notificationId, {
        detail: message,
      }, 'error');
      persistToolchainNotification({
        id: notificationId,
        kind: 'firmware-upload',
        title: `Failed to upload ${boardName} ${releaseVersion}`,
        detail: message,
        status: 'error',
        phase: 'error',
        progress: failedProgressTask?.progress ?? null,
        name: boardName,
        version: releaseVersion,
        target: boardName,
        metadata: {
          boardId: targetBoard.$id,
          boardType: targetBoard.boardType,
          filename: compileResult.filename,
        },
      });
      finishToast(toastId, {
        message: 'Firmware upload failed.',
        detail: message,
        tone: 'error',
        progress: failedProgressTask?.progress ?? null,
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function installTantalumCloudRuntime(options: {
    board: BoardDocument;
    port: string;
    profile?: LocalBoardProfile | null;
    localBoard?: LocalBoardRow | null;
    busyActionId?: string;
    closeModal?: boolean;
  }) {
    const { board, localBoard = null, busyActionId = 'provision', closeModal = false } = options;
    let port = options.port;
    let profile = options.profile ?? null;
    let resolvedLocalBoard = localBoard;

    if (!port && !localBoard) {
      pushToast('Select a USB port before installing Tantalum Cloud.', 'info');
      return null;
    }

    if (!hasDeviceGatewayFunction()) {
      pushToast('Device gateway function configuration is required before installing Tantalum Cloud.', 'error');
      return null;
    }

    const secretResult = await window.tantalum.secrets.getBoardSecrets(board.$id);
    if (!secretResult.success || !secretResult.secrets?.apiToken || !secretResult.secrets?.commandSecret || !secretResult.secrets?.mqttTopic || !secretResult.secrets?.provisioningPop) {
      pushToast('Local board secrets are missing. Rotate the board token, then install Tantalum Cloud again.', 'error');
      return null;
    }

    let notificationId: string | null = null;
    let toastId: number | null = null;
    let notificationTitle = '';
    let notificationMetadata: ToolchainNotificationMetadata = {};

    try {
      if (localBoard) {
        const resolution = await resolveLiveLocalBoardTarget(localBoard);
        resolvedLocalBoard = resolution.row;
        profile = resolution.savedProfile ?? resolution.row.profile ?? profile;
        port = resolution.row.port;

        if (!canUploadLocalBoard(resolution.row)) {
          const message = `Board is not available on the saved port. Run Auto detect or reconnect the board.`;
          pushConsole(message, 'error');
          pushToast('Local board unavailable.', 'error', undefined, { detail: message });
          return null;
        }
      }

      notificationId = createToolchainTaskId('cloud-runtime-install');
      notificationTitle = `Installing Tantalum Cloud on ${board.name}`;
      notificationMetadata = {
        boardId: board.$id,
        boardType: board.boardType,
        port,
      };
      const initialProgress = 5;
      const initialDetail = `Uploading Tantalum Cloud runtime to ${board.name} on ${port}...`;

      setBusyAction(busyActionId);
      persistToolchainNotification({
        id: notificationId,
        kind: 'cloud-runtime-install',
        title: notificationTitle,
        detail: initialDetail,
        status: 'running',
        phase: 'install',
        progress: initialProgress,
        name: board.name,
        target: port,
        metadata: notificationMetadata,
      });
      toastId = pushToast(notificationTitle, 'info', undefined, {
        detail: initialDetail,
        persistent: true,
        progress: initialProgress,
        progressLabel: formatReleaseProgressLabel(initialProgress),
        notificationId,
      });
      localBoardUploadProgressRef.current = {
        uploadId: notificationId,
        toastId,
        notificationId,
        lineBuffer: '',
        lastProgress: initialProgress,
        notificationKind: 'cloud-runtime-install',
        notificationTitle,
        notificationName: board.name,
        notificationTarget: port,
        notificationPhase: 'install',
        notificationMetadata,
        progressMode: 'cloud-runtime-install',
      };
      pushConsole(`Installing Tantalum Cloud on ${board.name} through ${port}...`);

      let result = await window.tantalum.toolchain.provisionBoard({
        board,
        port,
        uploadId: notificationId,
        secrets: secretResult.secrets,
        appwriteConfig: {
          endpoint: appwriteConfig.endpoint,
          projectId: appwriteConfig.projectId,
          deviceGatewayFunctionId: appwriteConfig.deviceGatewayFunctionId,
          firmwareBucketId: appwriteConfig.firmwareBucketId,
          mqttHost: appwriteConfig.mqttHost,
          mqttPort: appwriteConfig.mqttPort,
          mqttUsername: appwriteConfig.mqttUsername,
          mqttPassword: appwriteConfig.mqttPassword,
          mqttCaCert: appwriteConfig.mqttCaCert,
          tlsCaCert: appwriteConfig.tlsCaCert,
        },
      });

      if (!result.success && resolvedLocalBoard && isLocalBoardUploadRecoverableSerialError(result.error)) {
        const retryResolution = await resolveLiveLocalBoardTarget(resolvedLocalBoard);
        if (retryResolution.row.port && retryResolution.row.port !== port && canUploadLocalBoard(retryResolution.row)) {
          port = retryResolution.row.port;
          profile = retryResolution.savedProfile ?? retryResolution.row.profile ?? profile;
          resolvedLocalBoard = retryResolution.row;
          const retryMessage = `USB port changed from ${retryResolution.previousPort} to ${port}; retrying Tantalum Cloud install.`;
          pushConsole(retryMessage);
          notificationMetadata = {
            ...notificationMetadata,
            port,
          };
          persistToolchainNotification({
            id: notificationId,
            kind: 'cloud-runtime-install',
            title: notificationTitle,
            detail: retryMessage,
            status: 'running',
            phase: 'install',
            progress: localBoardUploadProgressRef.current?.uploadId === notificationId ? localBoardUploadProgressRef.current.lastProgress : initialProgress,
            name: board.name,
            target: port,
            metadata: notificationMetadata,
          });
          if (toastId !== null) {
            updateToast(toastId, {
              detail: retryMessage,
              tone: 'info',
              persistent: true,
              progress: localBoardUploadProgressRef.current?.uploadId === notificationId ? localBoardUploadProgressRef.current.lastProgress : initialProgress,
            });
          }
          if (localBoardUploadProgressRef.current?.uploadId === notificationId) {
            localBoardUploadProgressRef.current = {
              ...localBoardUploadProgressRef.current,
              notificationTarget: port,
              notificationMetadata,
            };
          }
          result = await window.tantalum.toolchain.provisionBoard({
            board,
            port,
            uploadId: notificationId,
            secrets: secretResult.secrets,
            appwriteConfig: {
              endpoint: appwriteConfig.endpoint,
              projectId: appwriteConfig.projectId,
              deviceGatewayFunctionId: appwriteConfig.deviceGatewayFunctionId,
              firmwareBucketId: appwriteConfig.firmwareBucketId,
              mqttHost: appwriteConfig.mqttHost,
              mqttPort: appwriteConfig.mqttPort,
              mqttUsername: appwriteConfig.mqttUsername,
              mqttPassword: appwriteConfig.mqttPassword,
              mqttCaCert: appwriteConfig.mqttCaCert,
              tlsCaCert: appwriteConfig.tlsCaCert,
            },
          });
        }
      }

      if (!result.success) {
        const blockerActions: Toast['actions'] | undefined = isLocalBoardUploadRecoverableSerialError(result.error) && port
          ? [{
              label: 'Find blockers',
              dismissOnSelect: false,
              onSelect: () => {
                setSerialBlockerDialog({
                  port,
                  title: 'Tantalum Cloud install blockers',
                  subtitle: `Checking ${port} before retrying the runtime install.`,
                  retryLabel: 'Retry install',
                  onRetry: () => {
                    setSerialBlockerDialog(null);
                    void installTantalumCloudRuntime({
                      board,
                      port,
                      profile,
                      localBoard: resolvedLocalBoard,
                      busyActionId,
                      closeModal,
                    });
                  },
                });
              },
            }]
          : undefined;
        pushConsole(result.error, 'error');
        const failedProgress = localBoardUploadProgressRef.current?.uploadId === notificationId ? localBoardUploadProgressRef.current.lastProgress : null;
        persistToolchainNotification({
          id: notificationId,
          kind: 'cloud-runtime-install',
          title: 'Tantalum Cloud install failed',
          detail: result.error,
          status: 'error',
          phase: 'error',
          progress: failedProgress,
          name: board.name,
          target: port,
          metadata: notificationMetadata,
        });
        if (toastId !== null) {
          if (blockerActions) {
            updateToast(toastId, {
              message: 'Tantalum Cloud install failed',
              detail: result.error,
              tone: 'error',
              progress: failedProgress,
              progressLabel: typeof failedProgress === 'number' ? formatReleaseProgressLabel(failedProgress) : undefined,
              persistent: true,
              actions: blockerActions,
            });
          } else {
            finishToast(toastId, {
              message: 'Tantalum Cloud install failed',
              detail: result.error,
              tone: 'error',
              progress: failedProgress,
              progressLabel: typeof failedProgress === 'number' ? formatReleaseProgressLabel(failedProgress) : undefined,
            });
          }
        } else {
          pushToast('Tantalum Cloud install failed.', 'error', undefined, { detail: result.error });
        }
        return null;
      }

      const provisionedAt = new Date().toISOString();
      await updateBoard(board.$id, {
        status: 'pending',
        provisioningStatus: 'pending',
        lastProvisionedAt: provisionedAt,
        updatedAt: provisionedAt,
      });
      if (profile) {
        const saveResult = await window.tantalum.toolchain.saveLocalBoardProfile({
          ...profile,
          port,
          lastCloudProvisionedAt: provisionedAt,
        });
        if (!saveResult.success) {
          throw new Error(saveResult.error);
        }
      }

      await refreshBoardsList();
      await refreshLocalBoardProfiles();
      if (closeModal) {
        setProvisionModalOpen(false);
      }
      persistToolchainNotification({
        id: notificationId,
        kind: 'cloud-runtime-install',
        title: `Tantalum Cloud installed on ${board.name}`,
        detail: result.message || 'Tantalum Cloud install complete.',
        status: 'success',
        phase: 'complete',
        progress: 100,
        name: board.name,
        target: port,
        metadata: notificationMetadata,
      });
      if (toastId !== null) {
        finishToast(toastId, {
          message: `Tantalum Cloud installed on ${board.name}`,
          detail: result.message || 'Tantalum Cloud install complete.',
          tone: 'success',
          progress: 100,
          progressLabel: '100%',
        });
      } else {
        pushToast(`Tantalum Cloud installed on ${board.name}.`, 'success');
      }
      pushConsole(result.message || 'Tantalum Cloud install complete.', 'success');
      return { provisionedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tantalum Cloud install failed.';
      pushConsole(message, 'error');
      if (notificationId) {
        const failedProgress = localBoardUploadProgressRef.current?.uploadId === notificationId ? localBoardUploadProgressRef.current.lastProgress : null;
        persistToolchainNotification({
          id: notificationId,
          kind: 'cloud-runtime-install',
          title: 'Tantalum Cloud install failed',
          detail: message,
          status: 'error',
          phase: 'error',
          progress: failedProgress,
          name: board.name,
          target: port,
          metadata: notificationMetadata,
        });
        if (toastId !== null) {
          finishToast(toastId, {
            message: 'Tantalum Cloud install failed',
            detail: message,
            tone: 'error',
            progress: failedProgress,
            progressLabel: typeof failedProgress === 'number' ? formatReleaseProgressLabel(failedProgress) : undefined,
          });
        } else {
          pushToast(message, 'error');
        }
      } else {
        pushToast(message, 'error');
      }
      return null;
    } finally {
      if (notificationId && localBoardUploadProgressRef.current?.uploadId === notificationId) {
        const bufferedLine = localBoardUploadProgressRef.current.lineBuffer.trim();
        if (bufferedLine) {
          pushConsole(bufferedLine, 'info');
        }
        localBoardUploadProgressRef.current = null;
      }
      setBusyAction(null);
    }
  }

  async function handleUploadEditorBoard() {
    if (selectedEditorCloudBoard) {
      await handleUploadRelease(selectedEditorCloudBoard);
      return;
    }

    await handleUploadLocal(selectedEditorLocalBoard);
  }

  async function handleProvisionBoard() {
    if (!selectedBoard || !selectedProvisionPort) {
      pushToast('Select both a board and a USB port.', 'info');
      return;
    }

    await installTantalumCloudRuntime({
      board: selectedBoard,
      port: selectedBoardLinkedLocalRow?.port || selectedProvisionPort,
      profile: selectedBoardLinkedLocalRow?.profile ?? null,
      localBoard: selectedBoardLinkedLocalRow,
      busyActionId: 'provision',
      closeModal: true,
    });
  }

  async function handleCreateBoard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!boardForm.name || !boardForm.boardType) {
      pushToast('Complete the board name and type.', 'error');
      return;
    }

    setBusyAction('create-board');
    try {
      const created = await createBoard(boardForm, user);
      await window.tantalum.secrets.setBoardSecrets({
        boardId: created.board.$id,
        apiToken: created.apiToken,
        commandSecret: created.commandSecret ?? '',
        mqttTopic: created.mqttTopic ?? '',
        provisioningPop: created.provisioningPop ?? '',
      });
      await refreshBoardsList();
      setSelectedBoardId(created.board.$id);
      setBoardModalOpen(false);
      setBoardForm({ name: '', boardType: 'esp32:esp32:esp32', sourceCodeVisibility: 'private' });
      pushToast(`Added ${created.board.name}`, 'success');
      pushConsole(`Board ${created.board.name} created. Provisioning secrets stored locally on this machine.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to create the board.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleMakeLocalBoardCloud(row: LocalBoardRow) {
    if (!row.profileId || !row.profile) {
      pushToast('Save the local board before enabling Tantalum Cloud.', 'info');
      return;
    }

    if (!isCloudCapableBoardFqbn(row.fqbn)) {
      pushToast('Only ESP32 and ESP8266 boards can be cloud boards.', 'error');
      return;
    }

    if (!hasRequiredCloudConfiguration() || !hasBoardAdminFunction() || !hasDeviceGatewayFunction()) {
      pushToast('Enabling Tantalum Cloud requires board-admin and device-gateway function configuration.', 'error');
      return;
    }

    if (!row.port && !row.fingerprint) {
      pushToast('Connect this board over USB before enabling Tantalum Cloud.', 'info');
      return;
    }

    if (row.cloudBoardId) {
      setSelectedBoardId(row.cloudBoardId);
      pushToast(`${localBoardDisplayName(row)} is already linked to a cloud board.`, 'info');
      return;
    }

    setBusyAction(`make-cloud-board:${row.key}`);
    try {
      const resolution = await resolveLiveLocalBoardTarget(row);
      const liveRow = resolution.row;
      if (!canUploadLocalBoard(liveRow)) {
        const message = 'Board is not available on the saved port. Run Auto detect or reconnect the board.';
        pushConsole(message, 'error');
        pushToast('Local board unavailable.', 'error', undefined, { detail: message });
        return;
      }

      const created = await createBoard({
        name: localBoardDisplayName(liveRow),
        boardType: liveRow.fqbn,
        sourceCodeVisibility: liveRow.sourceCodeVisibility === 'public' ? 'public' : 'private',
      }, user);
      if ((created.board.sourceCodeVisibility || 'private') !== (liveRow.sourceCodeVisibility || 'private')) {
        created.board = await updateBoard(created.board.$id, {
          sourceCodeVisibility: liveRow.sourceCodeVisibility === 'public' ? 'public' : 'private',
          updatedAt: new Date().toISOString(),
        });
      }

      if (!created.apiToken || !created.commandSecret || !created.mqttTopic || !created.provisioningPop) {
        throw new Error('Cloud board secrets were not returned. Check the board-admin function configuration.');
      }

      await window.tantalum.secrets.setBoardSecrets({
        boardId: created.board.$id,
        apiToken: created.apiToken,
        commandSecret: created.commandSecret,
        mqttTopic: created.mqttTopic,
        provisioningPop: created.provisioningPop,
      });

      const now = new Date().toISOString();
      const saveResult = await window.tantalum.toolchain.saveLocalBoardProfile({
        ...liveRow.profile,
        name: liveRow.name || liveRow.profile?.name,
        fqbn: liveRow.fqbn,
        boardLabel: liveRow.boardLabel,
        port: liveRow.port,
        protocol: liveRow.protocol,
        protocolLabel: liveRow.protocolLabel,
        manufacturer: liveRow.manufacturer,
        vendorId: liveRow.vendorId,
        productId: liveRow.productId,
        serialNumber: liveRow.serialNumber,
        pnpId: liveRow.pnpId,
        locationId: liveRow.locationId,
        fingerprint: liveRow.fingerprint,
        cloudBoardId: created.board.$id,
        cloudLinkedAt: now,
        sourceCodeVisibility: liveRow.sourceCodeVisibility || 'private',
      });
      if (!saveResult.success) {
        throw new Error(saveResult.error);
      }

      await refreshBoardsList();
      await refreshLocalBoardProfiles();
      setSelectedBoardId(created.board.$id);
      pushConsole('Cloud board created. Provisioning secrets were stored locally; WiFi credentials were not collected or uploaded. Installing Tantalum Cloud runtime now.', 'success');
      const installResult = await installTantalumCloudRuntime({
        board: created.board,
        port: liveRow.port,
        profile: saveResult.profile,
        localBoard: {
          ...liveRow,
          profile: saveResult.profile,
          profileId: saveResult.profile.id,
          cloudBoardId: created.board.$id,
          cloudLinkedAt: saveResult.profile.cloudLinkedAt,
        },
        busyActionId: `install-cloud-runtime:${row.key}`,
      });
      if (!installResult) {
        pushToast('Cloud board linked. Tantalum Cloud install is still needed.', 'info');
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to enable Tantalum Cloud for this board.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function linkLocalBoardToCloud(row: LocalBoardRow, board: BoardDocument, options: { quiet?: boolean; installRuntime?: boolean } = {}) {
    if (!row.profileId || !row.profile) {
      pushToast('Save the local board before linking it to cloud.', 'info');
      return null;
    }

    if (!isCloudCapableBoardFqbn(row.fqbn)) {
      pushToast('Only ESP32 and ESP8266 local boards can be linked to cloud boards.', 'error');
      return null;
    }

    if (row.cloudBoardId && row.cloudBoardId !== board.$id) {
      const existingBoard = boards.find((entry) => entry.$id === row.cloudBoardId);
      const confirmed = window.confirm(
        `${localBoardDisplayName(row)} is already linked to ${existingBoard?.name || row.cloudBoardId}. Relink it to ${board.name}?`,
      );
      if (!confirmed) {
        return null;
      }
    }

    setBusyAction(`link-cloud-board:${row.key}`);
    try {
      let liveRow = row;
      if (options.installRuntime) {
        const resolution = await resolveLiveLocalBoardTarget(row);
        liveRow = resolution.row;
        if (!canUploadLocalBoard(liveRow)) {
          const message = 'Board is not available on the saved port. Run Auto detect or reconnect the board.';
          pushConsole(message, 'error');
          pushToast('Local board unavailable.', 'error', undefined, { detail: message });
          return null;
        }
      }

      const result = await window.tantalum.toolchain.saveLocalBoardProfile({
        ...liveRow.profile,
        name: liveRow.name || liveRow.profile?.name,
        fqbn: liveRow.fqbn,
        boardLabel: liveRow.boardLabel,
        port: liveRow.port,
        protocol: liveRow.protocol,
        protocolLabel: liveRow.protocolLabel,
        manufacturer: liveRow.manufacturer,
        vendorId: liveRow.vendorId,
        productId: liveRow.productId,
        serialNumber: liveRow.serialNumber,
        pnpId: liveRow.pnpId,
        locationId: liveRow.locationId,
        fingerprint: liveRow.fingerprint,
        cloudBoardId: board.$id,
        cloudLinkedAt: new Date().toISOString(),
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      await refreshLocalBoardProfiles();
      setSelectedLocalBoardId(result.profile.id);
      setSelectedBoardId(board.$id);
      if (!options.quiet) {
        pushToast(`${board.name} linked to ${result.profile.name || result.profile.boardLabel || result.profile.fqbn}.`, 'success');
      }
      if (options.installRuntime && liveRow.connected && liveRow.port) {
        const installResult = await installTantalumCloudRuntime({
          board,
          port: liveRow.port,
          profile: result.profile,
          localBoard: {
            ...liveRow,
            profile: result.profile,
            profileId: result.profile.id,
            cloudBoardId: board.$id,
            cloudLinkedAt: result.profile.cloudLinkedAt,
          },
          busyActionId: `install-cloud-runtime:${row.key}`,
        });
        if (!installResult && !options.quiet) {
          pushToast('Local board linked. Tantalum Cloud install is still needed.', 'info');
        }
      }
      return result.profile;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to link local board.', 'error');
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLinkSelectedCloudBoardToLocal() {
    if (!selectedBoard) {
      return;
    }

    const row = localBoardRows.find((entry) => entry.profileId === selectedLinkLocalProfileId) ?? null;
    if (!row) {
      pushToast('Choose a saved local board to link.', 'info');
      return;
    }

    await linkLocalBoardToCloud(row, selectedBoard, { installRuntime: true });
  }

  const processPendingSelectedLocalCloudLink = useEffectEvent(async (request: { profileId: string; boardId: string }) => {
    const board = boards.find((entry) => entry.$id === request.boardId) ?? null;
    if (!board) {
      pushToast('Choose a cloud board to link.', 'info');
      return;
    }

    const row = localBoardRows.find((entry) => entry.profileId === request.profileId) ?? null;
    if (!row) {
      pushToast('Choose a saved local board to link.', 'info');
      return;
    }

    await linkLocalBoardToCloud(row, board, { installRuntime: true });
  });

  useEffect(() => {
    if (!pendingSelectedLocalCloudLink) {
      return;
    }

    const request = pendingSelectedLocalCloudLink;
    setPendingSelectedLocalCloudLink(null);
    void processPendingSelectedLocalCloudLink(request);
  }, [pendingSelectedLocalCloudLink]);

  async function openUsbWifiProvisioning(row: LocalBoardRow) {
    if (!row.profileId || !row.cloudBoardId) {
      pushToast('Link this local board to a cloud board before USB WiFi provisioning.', 'info');
      return;
    }

    if (!row.lastCloudProvisionedAt) {
      pushToast('Install Tantalum Cloud before sending WiFi credentials over USB.', 'info');
      return;
    }

    if (!row.port && !row.fingerprint) {
      pushToast('Connect the board over USB before WiFi provisioning.', 'info');
      return;
    }

    try {
      const resolution = await resolveLiveLocalBoardTarget(row);
      if (!canUploadLocalBoard(resolution.row)) {
        const message = 'Board is not available on the saved port. Run Auto detect or reconnect the board.';
        pushConsole(message, 'error');
        pushToast('Local board unavailable.', 'error', undefined, { detail: message });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to refresh local board ports before WiFi provisioning.';
      pushConsole(message, 'error');
      pushToast('Unable to refresh local board.', 'error', undefined, { detail: message });
      return;
    }

    setUsbWifiProfileId(row.profileId);
    setUsbWifiForm({ ssid: '', password: '' });
    setUsbWifiModalOpen(true);
  }

  async function handleInstallTantalumCloudForLocalBoard(row: LocalBoardRow, board: BoardDocument | null) {
    if (!row.profileId || !row.profile || !board) {
      pushToast('Link this local board to a cloud board before installing Tantalum Cloud.', 'info');
      return;
    }

    await installTantalumCloudRuntime({
      board,
      port: row.port,
      profile: row.profile,
      localBoard: row,
      busyActionId: `install-cloud-runtime:${row.key}`,
    });
  }

  const processPendingCloudRuntimeInstall = useEffectEvent(async (request: { profileId: string; boardId: string }) => {
    const board = boards.find((entry) => entry.$id === request.boardId) ?? null;
    const row = localBoardRows.find((entry) => entry.profileId === request.profileId) ?? null;
    if (!board || !row) {
      pushToast('Link and connect the matching local board before installing Tantalum Cloud.', 'info');
      return;
    }

    await handleInstallTantalumCloudForLocalBoard(row, board);
  });

  useEffect(() => {
    if (!pendingCloudRuntimeInstall) {
      return;
    }

    const request = pendingCloudRuntimeInstall;
    setPendingCloudRuntimeInstall(null);
    void processPendingCloudRuntimeInstall(request);
  }, [pendingCloudRuntimeInstall]);

  async function handleProvisionWifiOverUsb(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!usbWifiTargetRow?.cloudBoardId || (!usbWifiTargetRow.port && !usbWifiTargetRow.fingerprint)) {
      pushToast('Choose a linked USB board before provisioning WiFi.', 'info');
      return;
    }

    if (!usbWifiForm.ssid.trim()) {
      pushToast('WiFi SSID is required.', 'error');
      return;
    }

    setBusyAction('wifi-usb-provision');
    try {
      const resolution = await resolveLiveLocalBoardTarget(usbWifiTargetRow);
      if (!canUploadLocalBoard(resolution.row)) {
        const message = 'Board is not available on the saved port. Run Auto detect or reconnect the board.';
        pushConsole(message, 'error');
        pushToast('Local board unavailable.', 'error', undefined, { detail: message });
        return;
      }

      const targetCloudBoardId = usbWifiTargetRow.cloudBoardId;
      const result = await window.tantalum.toolchain.provisionBoardWifiUsb({
        boardId: targetCloudBoardId,
        port: resolution.row.port,
        ssid: usbWifiForm.ssid,
        password: usbWifiForm.password,
      });

      setUsbWifiForm({ ssid: '', password: '' });

      if (!result.success) {
        throw new Error(result.error);
      }

      if (usbWifiTargetRow.profile) {
        await window.tantalum.toolchain.saveLocalBoardProfile({
          ...usbWifiTargetRow.profile,
          lastCloudProvisionedAt: new Date().toISOString(),
        });
        await refreshLocalBoardProfiles();
      }

      setUsbWifiModalOpen(false);
      setUsbWifiProfileId('');
      pushToast('WiFi sent directly to the board over USB.', 'success');
      pushConsole('WiFi credentials were transferred directly over USB and were not stored by Tantalum IDE or uploaded to cloud.', 'success');
      void waitForCloudBoardHeartbeat(targetCloudBoardId);
    } catch (error) {
      setUsbWifiForm((current) => ({ ...current, password: '' }));
      pushToast(error instanceof Error ? error.message : 'USB WiFi provisioning failed.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  function updateLocalBoardEdit(rowKey: string, patch: LocalBoardEdit) {
    setLocalBoardEdits((current) => ({
      ...current,
      [rowKey]: {
        ...(current[rowKey] ?? {}),
        ...patch,
      },
    }));
  }

  function handleAddManualLocalBoard() {
    const key = createManualLocalBoardKey();
    setManualLocalBoardKeys((current) => [...current, key]);
    setExpandedLocalBoardKeys((current) => ({ ...current, [key]: true }));
    setLocalBoardAdvancedOpenKey(null);
    setLocalBoardCatalogQuery('');
  }

  function toggleLocalBoardExpanded(rowKey: string) {
    setExpandedLocalBoardKeys((current) => ({ ...current, [rowKey]: !current[rowKey] }));
  }

  async function handleSaveLocalBoard(row: LocalBoardRow) {
    const name = row.name.trim();
    const fqbn = row.fqbn.trim();
    const port = row.port.trim();

    if (!fqbn || !port) {
      pushToast('Choose a board type and port before saving.', 'error');
      return;
    }

    if (!isUploadableBoardFqbn(fqbn)) {
      pushToast('Choose an exact board type before saving.', 'error', undefined, { detail: 'ESP32 Family Device cannot be used for compile/upload.' });
      return;
    }

    setBusyAction(`save-local-board:${row.key}`);
    try {
      const result = await window.tantalum.toolchain.saveLocalBoardProfile({
        id: row.profileId,
        name,
        fqbn,
        boardLabel: row.boardLabel,
        port,
        protocol: row.protocol,
        protocolLabel: row.protocolLabel,
        manufacturer: row.manufacturer,
        vendorId: row.vendorId,
        productId: row.productId,
        serialNumber: row.serialNumber,
        pnpId: row.pnpId,
        locationId: row.locationId,
        fingerprint: row.fingerprint,
        confidence: row.confidence,
        connected: row.connected,
        cloudBoardId: row.cloudBoardId,
        cloudLinkedAt: row.cloudLinkedAt,
        lastCloudProvisionedAt: row.lastCloudProvisionedAt,
        lastCloudUsbUploadAt: row.lastCloudUsbUploadAt,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      setLocalBoardEdits((current) => {
        const next = { ...current };
        delete next[row.key];
        delete next[`local:${result.profile.id}`];
        delete next[localBoardProfileKey(result.profile.id)];
        return next;
      });
      setManualLocalBoardKeys((current) => current.filter((key) => key !== row.key));
      setLocalBoardProfiles((current) => {
        const existingIndex = current.findIndex((profile) => profile.id === result.profile.id);
        if (existingIndex < 0) {
          return [result.profile, ...current];
        }

        return current.map((profile, index) => (index === existingIndex ? result.profile : profile));
      });
      setExpandedLocalBoardKeys((current) => {
        const next = { ...current };
        delete next[row.key];
        next[localBoardProfileKey(result.profile.id)] = true;
        return next;
      });
      setSelectedLocalBoardId(result.profile.id);
      await refreshLocalBoardProfiles();
      pushToast(`Saved ${result.profile.name || result.profile.boardLabel || result.profile.fqbn}`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to save local board.', 'error');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteLocalBoard(row: LocalBoardRow) {
    if (!row.profileId) {
      setLocalBoardEdits((current) => {
        const next = { ...current };
        delete next[row.key];
        return next;
      });
      if (row.source === 'detected') {
        setDetectedLocalBoards((current) => current.filter((detection) => localBoardDetectedKey(detection) !== row.key));
      }
      setManualLocalBoardKeys((current) => current.filter((key) => key !== row.key));
      setExpandedLocalBoardKeys((current) => {
        const next = { ...current };
        delete next[row.key];
        return next;
      });
      setLocalBoardCatalogQuery('');
      return;
    }

    setBusyAction(`delete-local-board:${row.key}`);
    try {
      const result = await window.tantalum.toolchain.deleteLocalBoardProfile(row.profileId);
      if (!result.success) {
        throw new Error(result.error);
      }

      setLocalBoardProfiles(result.profiles);
      setLocalBoardEdits((current) => {
        const next = { ...current };
        delete next[row.key];
        return next;
      });
      setExpandedLocalBoardKeys((current) => {
        const next = { ...current };
        delete next[row.key];
        return next;
      });
      if (row.profileId === selectedLocalBoardId) {
        const nextSelectedProfile = result.profiles.find((profile) => Boolean(profile.connected)) ?? result.profiles[0] ?? null;
        setSelectedLocalBoardId(nextSelectedProfile?.id ?? '');
      }
      pushToast(`Forgot ${localBoardDisplayName(row)}`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to forget local board.', 'error');
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
        commandSecret: rotated.commandSecret ?? '',
        mqttTopic: rotated.mqttTopic ?? '',
        provisioningPop: rotated.provisioningPop ?? '',
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

  async function handleRequestBoardProvisioning(targetBoard = selectedBoard) {
    if (!targetBoard) {
      return;
    }

    if (calculateBoardStatus(targetBoard.lastSeen, targetBoard.status) !== 'online') {
      pushToast('Board is not online. Send WiFi directly over USB, or use BLE/SoftAP provisioning from mobile.', 'info');
      return;
    }

    setBusyAction('start-provisioning');
    try {
      const result = await startBoardProvisioning(targetBoard.$id);
      await refreshBoardsList();
      const mqttDetail = result.mqtt?.published ? 'MQTT command sent.' : result.mqtt?.reason || 'The board will also receive this request on its next heartbeat.';
      pushToast(`WiFi setup opened for ${targetBoard.name}`, 'success');
      pushConsole(`WiFi setup request saved. ${mqttDetail}`, result.mqtt?.published ? 'success' : 'info');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to request provisioning.', 'error');
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
      pushToast(`Deployment requested for ${firmware.version}`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to deploy firmware.', 'error');
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

  function getSelectedLibraryVersion(library: LibraryEntry) {
    const options = getLibraryDropdownVersionOptions(library);
    const selectedVersion = libraryVersionSelections[normalizePackageKey(library.name)];
    return selectedVersion && options.includes(selectedVersion) ? selectedVersion : options[0];
  }

  function handleLibraryVersionChange(library: LibraryEntry, version: string) {
    setLibraryVersionSelections((current) => ({
      ...current,
      [normalizePackageKey(library.name)]: version,
    }));
  }

  function handleSelectLibrary(library: LibraryEntry) {
    ensureManagerDetailPanelVisible();
    setLibraryDetailTab('overview');
    setSelectedLibraryKey(normalizePackageKey(library.name));
    void ensureLibraryMetadata(library);
  }

  function mergeLibraryMetadata(library: LibraryEntry) {
    const mergeEntry = (entry: LibraryEntry) => {
      if (normalizePackageKey(entry.name) !== normalizePackageKey(library.name)) {
        return entry;
      }

      return {
        ...entry,
        ...library,
        installed: entry.installed,
        installedVersion: entry.installedVersion ?? library.installedVersion,
      };
    };

    setDefaultLibraryResults((current) => current.map(mergeEntry));
    setLibraryResults((current) => current.map(mergeEntry));
    setInstalledLibraries((current) => current.map((entry) => {
      if (normalizePackageKey(entry.name) !== normalizePackageKey(library.name)) {
        return entry;
      }

      return {
        ...entry,
        ...library,
        installed: true,
        installedVersion: entry.installedVersion ?? entry.version ?? library.installedVersion,
      };
    }));
  }

  async function ensureLibraryMetadata(library: LibraryEntry) {
    if ((library.versions?.length ?? 0) > 0 && (library.releases?.length ?? 0) > 0 && library.website) {
      return library;
    }

    const libraryKey = normalizePackageKey(library.name);
    const existingRequest = libraryMetadataRequestsRef.current.get(libraryKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = window.tantalum.toolchain.searchLibraries(library.name)
      .then((result) => {
        if (!result.success) {
          return null;
        }

        const libraries = (result.libraries as LibraryEntry[]) ?? [];
        const metadata = libraries.find((entry) => normalizePackageKey(entry.name) === libraryKey) ?? libraries[0] ?? null;
        if (!metadata) {
          return null;
        }

        const mergedLibrary = {
          ...library,
          ...metadata,
          installed: library.installed,
          installedVersion: library.installedVersion ?? metadata.installedVersion,
        };
        mergeLibraryMetadata(mergedLibrary);
        return mergedLibrary;
      })
      .catch(() => null)
      .finally(() => {
        libraryMetadataRequestsRef.current.delete(libraryKey);
      });

    libraryMetadataRequestsRef.current.set(libraryKey, request);
    return request;
  }

  async function handleOpenLibraryInfo(library: LibraryEntry) {
    const metadata = await ensureLibraryMetadata(library);
    const website = metadata?.website || library.website;

    if (!website) {
      pushToast(`No info link is available for ${library.name}.`, 'error');
      return;
    }

    const result = await window.tantalum.shell.openExternal(website);
    if (!result.success) {
      pushToast(result.error, 'error');
    }
  }

  function getLibraryInstallState(library: LibraryEntry) {
    const libraryKey = normalizePackageKey(library.name);
    const selectedVersion = getSelectedLibraryVersion(library);
    const selectedInstallVersion = getInstallVersionForPayload(selectedVersion);
    const latestVersion = getLibraryLatestVersion(library);
    const installedVersion = getLibraryInstalledVersion(library);
    const isOutdated = isLibraryOutdated(library);
    const isInstalling = Boolean(activeLibraryInstalls[libraryKey]);
    const isRemoving = busyAction === `remove-library:${libraryKey}`;
    const installedSelectedVersion = Boolean(
      library.installed &&
        (selectedInstallVersion
          ? !installedVersion || managerVersionsMatch(selectedInstallVersion, installedVersion)
          : !latestVersion || !installedVersion || managerVersionsMatch(installedVersion, latestVersion))
    );

    return {
      libraryKey,
      selectedVersion,
      latestVersion,
      installedVersion,
      isInstalling,
      isRemoving,
      isOutdated,
      installedSelectedVersion,
    };
  }

  function getLibraryNotificationKind(library?: LibraryEntry): ToolchainNotificationKind {
    return library?.installed ? 'library-update' : 'library-install';
  }

  function getLibraryNotificationFromProgress(event: LibraryInstallProgressEvent, library?: LibraryEntry): ToolchainNotificationInput {
    const kind = getLibraryNotificationKind(library);
    const versionLabel = event.version ? ` ${event.version}` : '';
    const title =
      event.status === 'success'
        ? `Installed ${event.name}`
        : event.status === 'error'
          ? `Failed to install ${event.name}`
          : event.status === 'canceled'
            ? `Stopped installing ${event.name}`
            : `Installing ${event.name}${versionLabel}`;

    return {
      id: event.installId,
      kind,
      title,
      detail: event.message,
      name: event.name,
      version: event.version ?? '',
      target: event.name,
      status: event.status,
      phase: event.phase,
      progress: event.progress,
      metadata: {
        installId: event.installId,
        website: library?.website ?? null,
      },
    };
  }

  function clearStoppingInstall(installId: string) {
    setStoppingInstallIds((current) => {
      if (!current[installId]) {
        return current;
      }

      const next = { ...current };
      delete next[installId];
      return next;
    });
  }

  async function handleCancelLibraryInstallById(installId: string, name: string) {
    if (!installId || stoppingInstallIds[installId]) {
      return;
    }

    if (!window.confirm(`Stop installing ${name}?`)) {
      return;
    }

    setStoppingInstallIds((current) => ({ ...current, [installId]: true }));
    const toastId = libraryInstallToastIdsRef.current.get(installId);
    if (toastId) {
      updateToast(toastId, {
        detail: `Stopping ${name} install...`,
        actions: [],
        persistent: true,
        progress: null,
      });
    }

    const result = await window.tantalum.toolchain.cancelLibraryInstall({ installId }).catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'Unable to stop library install.',
    }));

    if (!result.success) {
      clearStoppingInstall(installId);
      if (toastId) {
        updateToast(toastId, {
          detail: result.error,
          tone: 'error',
        });
      } else {
        pushToast(result.error, 'error');
      }
    }
  }

  function handleCancelLibraryInstall(library: LibraryEntry) {
    const installId = activeLibraryInstalls[normalizePackageKey(library.name)];
    if (!installId) {
      return;
    }

    void handleCancelLibraryInstallById(installId, library.name);
  }

  function updateLibraryInstallToast(event: LibraryInstallProgressEvent, library?: LibraryEntry) {
    const notification = getLibraryNotificationFromProgress(event, library);
    persistToolchainNotification(notification);
    const existingToastId = libraryInstallToastIdsRef.current.get(event.installId);
    const versionLabel = event.version ? ` ${event.version}` : '';
    const isSettled = event.status === 'success' || event.status === 'error' || event.status === 'canceled';
    const tone: Toast['tone'] = event.status === 'error' ? 'error' : event.status === 'success' ? 'success' : 'info';
    const message =
      event.status === 'success'
        ? `Installed ${event.name}`
        : event.status === 'error'
          ? `Failed to install ${event.name}`
          : event.status === 'canceled'
            ? `Stopped installing ${event.name}`
            : `Installing ${event.name}${versionLabel}`;
    const detail = event.message || (event.status === 'queued' ? 'Preparing install...' : 'Downloading library...');
    const progress = event.status === 'success' ? 100 : event.status === 'canceled' ? undefined : event.progress;
    const isStopping = stoppingInstallIds[event.installId] || event.phase === 'stopping';
    const actions = isSettled || isStopping
      ? []
      : [{
          label: 'Stop',
          dismissOnSelect: false,
          onSelect: () => void handleCancelLibraryInstallById(event.installId, event.name),
        }];

    if (!existingToastId) {
      const toastId = pushToast(message, tone, actions, {
        detail,
        persistent: !isSettled,
        progress,
        notificationId: event.installId,
      });
      libraryInstallToastIdsRef.current.set(event.installId, toastId);
      if (isSettled) {
        window.setTimeout(() => dismissToast(toastId), 5000);
      }
      return;
    }

    if (isSettled) {
      clearStoppingInstall(event.installId);
      finishToast(existingToastId, { message, detail, tone, progress, actions: [] });
      return;
    }

    updateToast(existingToastId, {
      message,
      detail,
      tone,
      progress,
      persistent: true,
      actions,
    });
  }

  async function handleInstallLibrary(library: LibraryEntry, requestedVersion?: string) {
    const selectedVersion = requestedVersion ?? getSelectedLibraryVersion(library);
    const version = getInstallVersionForPayload(selectedVersion);
    const installId = createToolchainTaskId('library');
    const libraryKey = normalizePackageKey(library.name);

    setActiveLibraryInstalls((current) => ({ ...current, [libraryKey]: installId }));
    persistToolchainNotification(getLibraryNotificationFromProgress({
      installId,
      name: library.name,
      version,
      status: 'queued',
      phase: 'prepare',
      message: `Preparing ${library.name} install...`,
      progress: null,
    }, library));

    const toastId = pushToast(`Installing ${library.name}${version ? ` ${version}` : ''}`, 'info', [{
      label: 'Stop',
      dismissOnSelect: false,
      onSelect: () => void handleCancelLibraryInstallById(installId, library.name),
    }], {
      detail: 'Preparing install...',
      persistent: true,
      progress: null,
      notificationId: installId,
    });
    libraryInstallToastIdsRef.current.set(installId, toastId);

    const result = await window.tantalum.toolchain.installLibrary({ name: library.name, version, installId }).catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'Unable to install library.',
    }));
    setActiveLibraryInstalls((current) => {
      const next = { ...current };
      delete next[libraryKey];
      return next;
    });
    clearStoppingInstall(installId);

    if (!result.success) {
      const wasCanceled = 'canceled' in result && Boolean(result.canceled);
      const failedEvent: LibraryInstallProgressEvent = {
        installId,
        name: library.name,
        version,
        status: wasCanceled ? 'canceled' : 'error',
        phase: wasCanceled ? 'canceled' : 'error',
        message: wasCanceled ? `${library.name} install stopped.` : result.error,
        progress: null,
      };
      updateLibraryInstallToast(failedEvent, library);
      return;
    }

    pushConsole(normalizeOutput(result.output || `Installed ${library.name}`), 'success');
    const successEvent: LibraryInstallProgressEvent = {
      installId,
      name: library.name,
      version,
      status: 'success',
      phase: 'complete',
      message: `${library.name} installed.`,
      progress: 100,
    };
    updateLibraryInstallToast(successEvent, library);
    await refreshInstalledLibraries();
  }

  async function handleRemoveLibrary(library: LibraryEntry) {
    if (!window.confirm(`Remove ${library.name}?`)) {
      return;
    }

    const libraryKey = normalizePackageKey(library.name);
    const notificationId = createToolchainTaskId('remove-library');
    persistToolchainNotification({
      id: notificationId,
      kind: 'library-remove',
      title: `Removing ${library.name}`,
      detail: 'Removing installed library...',
      status: 'running',
      phase: 'remove',
      progress: null,
      name: library.name,
      target: library.name,
      metadata: { libraryKey },
    });
    const toastId = pushToast(`Removing ${library.name}`, 'info', undefined, {
      detail: 'Removing installed library...',
      persistent: true,
      progress: null,
      notificationId,
    });

    setBusyAction(`remove-library:${libraryKey}`);
    const result = await window.tantalum.toolchain.removeLibrary({ name: library.name }).catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'Unable to remove library.',
    }));
    setBusyAction(null);

    if (!result.success) {
      persistToolchainNotification({
        id: notificationId,
        kind: 'library-remove',
        title: `Failed to remove ${library.name}`,
        detail: result.error,
        status: 'error',
        phase: 'error',
        progress: null,
        name: library.name,
        target: library.name,
        metadata: { libraryKey },
      });
      finishToast(toastId, {
        message: `Failed to remove ${library.name}`,
        detail: result.error,
        tone: 'error',
        progress: null,
      });
      return;
    }

    pushConsole(normalizeOutput(result.output || `Removed ${library.name}`), 'success');
    persistToolchainNotification({
      id: notificationId,
      kind: 'library-remove',
      title: `Removed ${library.name}`,
      detail: `${library.name} removed.`,
      status: 'success',
      phase: 'complete',
      progress: 100,
      name: library.name,
      target: library.name,
      metadata: { libraryKey },
    });
    finishToast(toastId, {
      message: `Removed ${library.name}`,
      detail: `${library.name} removed.`,
      tone: 'success',
      progress: 100,
    });
    await refreshInstalledLibraries();
  }

  function getSelectedPlatformVersion(platform: BoardPlatform) {
    const options = getPlatformDropdownVersionOptions(platform);
    const selectedVersion = platformVersionSelections[normalizePackageKey(platform.id)];
    return selectedVersion && options.includes(selectedVersion) ? selectedVersion : options[0];
  }

  function handlePlatformVersionChange(platform: BoardPlatform, version: string) {
    setPlatformVersionSelections((current) => ({
      ...current,
      [normalizePackageKey(platform.id)]: version,
    }));
  }

  function handleSelectPlatform(platform: BoardPlatform) {
    ensureManagerDetailPanelVisible();
    setPlatformDetailTab('overview');
    setSelectedPlatformKey(normalizePackageKey(platform.id));
  }

  async function handleOpenPlatformInfo(platform: BoardPlatform) {
    if (!platform.website) {
      pushToast(`No info link is available for ${platform.name}.`, 'error');
      return;
    }

    const result = await window.tantalum.shell.openExternal(platform.website);
    if (!result.success) {
      pushToast(result.error, 'error');
    }
  }

  async function handleCancelPlatformInstallById(installId: string, name: string) {
    if (!installId || stoppingInstallIds[installId]) {
      return;
    }

    if (!window.confirm(`Stop installing ${name}?`)) {
      return;
    }

    setStoppingInstallIds((current) => ({ ...current, [installId]: true }));

    const task = platformInstallProgressRef.current?.installId === installId ? platformInstallProgressRef.current : null;
    if (task) {
      const nextTask = { ...task, stopping: true };
      platformInstallProgressRef.current = nextTask;
      updateToast(nextTask.toastId, {
        message: `Stopping ${name}`,
        detail: 'Stopping board core install...',
        actions: [],
        persistent: true,
        progress: nextTask.progress,
      });
    }

    const result = await window.tantalum.toolchain.cancelBoardPackageInstall({ installId }).catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'Unable to stop board core install.',
    }));

    if (!result.success) {
      clearStoppingInstall(installId);
      if (task) {
        const nextTask = { ...task, stopping: false };
        platformInstallProgressRef.current = nextTask;
        updateToast(nextTask.toastId, {
          detail: result.error,
          tone: 'error',
        });
      } else {
        pushToast(result.error, 'error');
      }
    }
  }

  function getPlatformInstallNotificationKind(platform: BoardPlatform): ToolchainNotificationKind {
    return platform.installed ? 'platform-update' : 'platform-install';
  }

  function getToolchainNotificationActions(notification: ToolchainNotification): Toast['actions'] {
    if (!isActiveToolchainNotification(notification)) {
      return [];
    }

    const installId = typeof notification.metadata.installId === 'string' ? notification.metadata.installId : notification.id;
    const name = notification.name || notification.target || notification.title;

    if (notification.kind === 'library-install' || notification.kind === 'library-update') {
      return [{
        label: 'Stop',
        dismissOnSelect: false,
        onSelect: () => void handleCancelLibraryInstallById(installId, name),
      }];
    }

    if (notification.kind === 'platform-install' || notification.kind === 'platform-update') {
      return [{
        label: 'Stop',
        dismissOnSelect: false,
        onSelect: () => void handleCancelPlatformInstallById(installId, name),
      }];
    }

    return [];
  }

  function showToolchainNotificationToast(notification: ToolchainNotification) {
    if (!isActiveToolchainNotification(notification)) {
      return;
    }

    const existingToastId = toolchainNotificationToastIdsRef.current.get(notification.id);
    const existingToastVisible = Boolean(existingToastId && toastsRef.current.some((toast) => toast.id === existingToastId));
    const patch = {
      message: notification.title,
      detail: notification.detail,
      tone: getToolchainToastTone(notification),
      progress: notification.progress,
      progressLabel: typeof notification.progress === 'number' ? formatReleaseProgressLabel(notification.progress) : undefined,
      persistent: true,
      actions: getToolchainNotificationActions(notification),
      notificationId: notification.id,
    };

    if (existingToastId && existingToastVisible) {
      updateToast(existingToastId, patch);
      return;
    }

    if (existingToastId) {
      toolchainNotificationToastIdsRef.current.delete(notification.id);
    }

    const toastId = pushToast(notification.title, getToolchainToastTone(notification), patch.actions, {
      detail: notification.detail,
      persistent: true,
      progress: notification.progress,
      progressLabel: typeof notification.progress === 'number' ? formatReleaseProgressLabel(notification.progress) : undefined,
      notificationId: notification.id,
    });
    const installId = typeof notification.metadata.installId === 'string' ? notification.metadata.installId : notification.id;
    if (notification.kind === 'library-install' || notification.kind === 'library-update') {
      libraryInstallToastIdsRef.current.set(installId, toastId);
    }
    if (notification.kind === 'library-migration') {
      libraryMigrationToastIdRef.current = toastId;
    }
    if (
      (notification.kind === 'platform-install' || notification.kind === 'platform-update' || notification.kind === 'platform-remove') &&
      platformInstallProgressRef.current?.installId === installId
    ) {
      platformInstallProgressRef.current = {
        ...platformInstallProgressRef.current,
        toastId,
      };
    }
    if (localBoardUploadProgressRef.current?.notificationId === notification.id) {
      localBoardUploadProgressRef.current = {
        ...localBoardUploadProgressRef.current,
        toastId,
      };
    }
  }

  const restoreToolchainNotificationToast = useEffectEvent((notification: ToolchainNotification) => {
    showToolchainNotificationToast(notification);
  });

  const showAgentToolchainNotificationToasts = useEffectEvent((notifications: ToolchainNotification[]) => {
    notifications
      .filter((notification) => notification.metadata?.agentTool)
      .forEach((notification) => showToolchainNotificationToast(notification));
  });

  function updatePlatformInstallProgressToast(chunk: string) {
    let task = platformInstallProgressRef.current;
    if (!task) {
      return;
    }

    const nextProgress = extractInstallProgressPercent(chunk);
    if (nextProgress !== null) {
      task = { ...task, progress: nextProgress };
      platformInstallProgressRef.current = task;
    }

    const fallback = task.operation === 'remove' ? 'Removing board core...' : 'Installing board core...';
    const detail = formatInstallProgressMessage(chunk, fallback);
    const versionLabel = task.operation === 'install' && task.version && task.version !== 'latest' ? ` ${task.version}` : '';
    const titleVerb = task.operation === 'remove' ? 'Removing' : task.notificationKind === 'platform-update' ? 'Updating' : 'Installing';
    const title = `${titleVerb} ${task.name}${versionLabel}`;

    persistToolchainNotification({
      id: task.installId,
      kind: task.notificationKind,
      title,
      detail,
      status: 'running',
      phase: task.operation === 'remove' ? 'remove' : 'install',
      progress: task.progress,
      name: task.name,
      version: task.version ?? '',
      target: task.name,
      metadata: {
        installId: task.installId,
        platformId: task.platformId,
        operation: task.operation,
      },
    });

    updateToast(task.toastId, {
      message: title,
      detail,
      tone: 'info',
      persistent: true,
      progress: task.progress,
      actions: task.operation === 'install' && !task.stopping
        ? [{
            label: 'Stop',
            dismissOnSelect: false,
            onSelect: () => void handleCancelPlatformInstallById(task.installId, task.name),
          }]
        : [],
    });
  }

  async function handleInstallPlatform(platform: BoardPlatform, requestedVersion?: string) {
    const selectedVersion = requestedVersion ?? getSelectedPlatformVersion(platform);
    const installVersion = getPlatformInstallVersion(platform, selectedVersion);
    const installId = createToolchainTaskId('platform');
    const notificationKind = getPlatformInstallNotificationKind(platform);
    const notificationTitle = `${notificationKind === 'platform-update' ? 'Updating' : 'Installing'} ${platform.name}${installVersion !== 'latest' ? ` ${installVersion}` : ''}`;
    persistToolchainNotification({
      id: installId,
      kind: notificationKind,
      title: notificationTitle,
      detail: 'Preparing board core install...',
      status: 'queued',
      phase: 'prepare',
      progress: null,
      name: platform.name,
      version: installVersion,
      target: platform.name,
      metadata: {
        installId,
        platformId: platform.id,
        operation: 'install',
      },
    });
    const toastId = pushToast(notificationTitle, 'info', [{
      label: 'Stop',
      dismissOnSelect: false,
      onSelect: () => void handleCancelPlatformInstallById(installId, platform.name),
    }], {
      detail: 'Preparing board core install...',
      persistent: true,
      progress: null,
      notificationId: installId,
    });

    platformInstallProgressRef.current = {
      installId,
      platformId: platform.id,
      name: platform.name,
      operation: 'install',
      notificationKind,
      toastId,
      version: installVersion,
      progress: null,
    };

    setActivePlatformInstalls((current) => ({ ...current, [platform.id]: installId }));
    setBusyAction(`platform:${platform.id}`);
    const result = await window.tantalum.toolchain.installBoardPackage({ packageName: `${platform.id}@${installVersion}`, installId }).catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'Unable to install board core.',
    }));
    setBusyAction(null);
    setActivePlatformInstalls((current) => {
      const next = { ...current };
      delete next[platform.id];
      return next;
    });
    clearStoppingInstall(installId);
    const progressTask = platformInstallProgressRef.current?.toastId === toastId ? platformInstallProgressRef.current : null;
    if (progressTask) {
      platformInstallProgressRef.current = null;
    }

    if (!result.success) {
      if ('canceled' in result && result.canceled) {
        pushConsole(`Stopped installing ${platform.name}.`, 'info');
        persistToolchainNotification({
          id: installId,
          kind: notificationKind,
          title: `Stopped installing ${platform.name}`,
          detail: 'Board core install stopped.',
          status: 'canceled',
          phase: 'canceled',
          progress: progressTask?.progress ?? null,
          name: platform.name,
          version: installVersion,
          target: platform.name,
          metadata: { installId, platformId: platform.id, operation: 'install' },
        });
        finishToast(toastId, {
          message: `Stopped installing ${platform.name}`,
          detail: 'Board core install stopped.',
          tone: 'info',
          progress: progressTask?.progress ?? null,
          actions: [],
        });
        return;
      }

      persistToolchainNotification({
        id: installId,
        kind: notificationKind,
        title: `Failed to install ${platform.name}`,
        detail: result.error,
        status: 'error',
        phase: 'error',
        progress: progressTask?.progress ?? null,
        name: platform.name,
        version: installVersion,
        target: platform.name,
        metadata: { installId, platformId: platform.id, operation: 'install' },
      });
      finishToast(toastId, {
        message: `Failed to install ${platform.name}`,
        detail: result.error,
        tone: 'error',
        progress: progressTask?.progress ?? null,
        actions: [],
      });
      return;
    }

    pushConsole(normalizeOutput(result.output || `Installed ${platform.id}@${installVersion}`), 'success');
    persistToolchainNotification({
      id: installId,
      kind: notificationKind,
      title: `${notificationKind === 'platform-update' ? 'Updated' : 'Installed'} ${platform.name}`,
      detail: `${platform.name} ${installVersion} installed.`,
      status: 'success',
      phase: 'complete',
      progress: 100,
      name: platform.name,
      version: installVersion,
      target: platform.name,
      metadata: { installId, platformId: platform.id, operation: 'install' },
    });
    finishToast(toastId, {
      message: `Installed ${platform.name}`,
      detail: `${platform.name} ${installVersion} installed.`,
      tone: 'success',
      progress: 100,
      actions: [],
    });
    await refreshInstalledPlatforms();
  }

  async function handleRemovePlatform(platform: BoardPlatform) {
    if (!window.confirm(`Remove ${platform.name}?`)) {
      return;
    }

    const installId = createToolchainTaskId('remove-platform');
    persistToolchainNotification({
      id: installId,
      kind: 'platform-remove',
      title: `Removing ${platform.name}`,
      detail: 'Preparing board core removal...',
      status: 'queued',
      phase: 'prepare',
      progress: null,
      name: platform.name,
      target: platform.name,
      metadata: {
        installId,
        platformId: platform.id,
        operation: 'remove',
      },
    });
    const toastId = pushToast(`Removing ${platform.name}`, 'info', undefined, {
      detail: 'Preparing board core removal...',
      persistent: true,
      progress: null,
      notificationId: installId,
    });

    platformInstallProgressRef.current = {
      installId,
      platformId: platform.id,
      name: platform.name,
      operation: 'remove',
      notificationKind: 'platform-remove',
      toastId,
      progress: null,
    };

    setBusyAction(`remove-platform:${platform.id}`);
    const result = await window.tantalum.toolchain.removeBoardPackage({ packageName: platform.id }).catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'Unable to remove board core.',
    }));
    setBusyAction(null);
    const progressTask = platformInstallProgressRef.current?.toastId === toastId ? platformInstallProgressRef.current : null;
    if (progressTask) {
      platformInstallProgressRef.current = null;
    }

    if (!result.success) {
      persistToolchainNotification({
        id: installId,
        kind: 'platform-remove',
        title: `Failed to remove ${platform.name}`,
        detail: result.error,
        status: 'error',
        phase: 'error',
        progress: progressTask?.progress ?? null,
        name: platform.name,
        target: platform.name,
        metadata: { installId, platformId: platform.id, operation: 'remove' },
      });
      finishToast(toastId, {
        message: `Failed to remove ${platform.name}`,
        detail: result.error,
        tone: 'error',
        progress: progressTask?.progress ?? null,
      });
      return;
    }

    pushConsole(normalizeOutput(result.output || `Removed ${platform.id}`), 'success');
    persistToolchainNotification({
      id: installId,
      kind: 'platform-remove',
      title: `Removed ${platform.name}`,
      detail: `${platform.name} removed.`,
      status: 'success',
      phase: 'complete',
      progress: 100,
      name: platform.name,
      target: platform.name,
      metadata: { installId, platformId: platform.id, operation: 'remove' },
    });
    finishToast(toastId, {
      message: `Removed ${platform.name}`,
      detail: `${platform.name} removed.`,
      tone: 'success',
      progress: 100,
    });
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
          pushToast('Open a Project before searching.', 'info');
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
      case 'show-serial-monitor':
        openConsolePanel('serial');
        break;
      case 'compile':
        await handleCompile();
        break;
      case 'upload-local':
        await handleUploadLocal();
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
    updatePlatformInstallProgressToast(chunk);
  });

  const handleCompileProgress = useEffectEvent((event: CompileProgressEvent) => {
    const task = firmwareReleaseProgressRef.current;
    if (!task || task.notificationId !== event.compileId) {
      return;
    }

    const estimate = estimateCompileProgressFromEvent(task, event);
    updateFirmwareReleaseProgress(task.notificationId, {
      ...estimate,
      compileEventCount: task.compileEventCount + 1,
    });
  });

  const handleStorageUploadProgress = useEffectEvent((event: StorageUploadProgressEvent) => {
    const task = firmwareReleaseProgressRef.current;
    if (!task || task.uploadProgressId !== event.progressId) {
      return;
    }

    if (event.progress >= 100) {
      updateFirmwareReleaseProgress(task.notificationId, {
        phase: 'queue',
        detail: FIRMWARE_RELEASE_PHASE_CONFIG.queue.fallbackDetail,
        progress: FIRMWARE_RELEASE_PHASE_CONFIG.queue.start,
      });
      return;
    }

    updateFirmwareReleaseProgress(task.notificationId, {
      phase: 'storage',
      detail: `Uploading firmware binary (${formatBytes(event.sentBytes)} of ${formatBytes(event.totalBytes)})...`,
      progress: mapStorageUploadProgress(event.progress),
    });
  });

  const handleUsbUploadProgress = useEffectEvent((event: UsbUploadProgressEvent) => {
    const task = localBoardUploadProgressRef.current;
    if (!task || task.uploadId !== event.uploadId) {
      return;
    }

    const normalizedChunk = normalizeToolchainStreamChunk(event.chunk);
    const combined = `${task.lineBuffer}${normalizedChunk}`;
    const complete = combined.endsWith('\n');
    const parts = combined.split('\n');
    const completeLines = complete ? parts : parts.slice(0, -1);
    task.lineBuffer = complete ? '' : parts.at(-1) ?? '';

    const lines = completeLines.map((line) => line.trimEnd()).filter((line) => line.trim());
    if (lines.length > 0) {
      setConsoleEntries((current) => [
        ...current,
        ...lines.map((line) => ({
          id: Date.now() + Math.random(),
          level: 'info' as const,
          message: line,
        })),
      ]);
    } else if (task.lineBuffer.length > 2000) {
      pushConsole(task.lineBuffer, 'info');
      task.lineBuffer = '';
    }

    const detail = event.message || lines.at(-1) || (task.progressMode === 'cloud-runtime-install' ? 'Installing Tantalum Cloud runtime...' : 'Uploading over USB...');
    task.lastProgress = getUsbUploadTaskProgress(task, event);
    persistToolchainNotification({
      id: task.notificationId,
      kind: task.notificationKind,
      title: task.notificationTitle,
      detail,
      status: 'running',
      phase: task.notificationPhase,
      progress: task.lastProgress,
      name: task.notificationName,
      version: task.notificationVersion ?? '',
      target: task.notificationTarget,
      metadata: task.notificationMetadata,
    });
    updateToast(task.toastId, {
      detail,
      progress: task.lastProgress,
      progressLabel: typeof task.lastProgress === 'number' ? formatReleaseProgressLabel(task.lastProgress) : undefined,
    });
  });

  const handleLibraryInstallProgress = useEffectEvent((event: LibraryInstallProgressEvent) => {
    const matchingLibrary = [...libraryResults, ...defaultLibraryResults, ...installedLibraries].find(
      (library) => normalizePackageKey(library.name) === normalizePackageKey(event.name),
    );

    updateLibraryInstallToast(event, matchingLibrary);

    if (event.status === 'success' || event.status === 'error' || event.status === 'canceled') {
      clearStoppingInstall(event.installId);
      setActiveLibraryInstalls((current) => {
        const libraryKey = normalizePackageKey(event.name);
        if (!current[libraryKey]) {
          return current;
        }

        const next = { ...current };
        delete next[libraryKey];
        return next;
      });
    }
  });

  const handleLibraryMigrationProgress = useEffectEvent((event: LibraryMigrationProgressEvent) => {
    const notificationId = libraryMigrationNotificationIdRef.current ?? createToolchainTaskId('library-migration');
    libraryMigrationNotificationIdRef.current = notificationId;
    const complete = event.progress === 100 || event.phase.toLowerCase().includes('complete');
    const failed = event.failed > 0 && complete;
    const status = complete ? (failed ? 'error' : 'success') : 'running';
    const title = complete
      ? failed
        ? 'Library migration completed with errors'
        : 'Library migration complete'
      : 'Migrating libraries';

    persistToolchainNotification({
      id: notificationId,
      kind: 'library-migration',
      title,
      detail: event.message,
      status,
      phase: event.phase,
      progress: event.progress,
      name: 'Library migration',
      target: 'Arduino libraries',
      metadata: {
        migrated: event.migrated,
        skipped: event.skipped,
        failed: event.failed,
        total: event.total,
      },
    });

    const existingToastId = libraryMigrationToastIdRef.current;
    const existingToastVisible = Boolean(existingToastId && toastsRef.current.some((toast) => toast.id === existingToastId));

    if (!existingToastId) {
      const toastId = pushToast(title, failed ? 'error' : complete ? 'success' : 'info', undefined, {
        detail: event.message,
        persistent: !complete,
        progress: event.progress,
        notificationId,
      });
      libraryMigrationToastIdRef.current = toastId;
      if (complete) {
        window.setTimeout(() => dismissToast(toastId), 5000);
        libraryMigrationNotificationIdRef.current = null;
        libraryMigrationToastIdRef.current = null;
      }
      return;
    }

    if (!existingToastVisible) {
      if (complete) {
        libraryMigrationNotificationIdRef.current = null;
        libraryMigrationToastIdRef.current = null;
      }
      return;
    }

    if (complete) {
      finishToast(existingToastId, {
        message: title,
        detail: event.message,
        tone: failed ? 'error' : 'success',
        progress: event.progress,
      });
      libraryMigrationNotificationIdRef.current = null;
      libraryMigrationToastIdRef.current = null;
      return;
    }

    updateToast(existingToastId, {
      message: title,
      detail: event.message,
      tone: 'info',
      persistent: true,
      progress: event.progress,
    });
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
    void refreshLocalBoards({ silent: true, portsOnly: true });
    void refreshInstalledLibraries();
    void refreshInstalledPlatforms();
    void refreshDefaultLibraries();
    void refreshDefaultPlatforms();
    void refreshProjectFolders();
  });

  const refreshLocalBoardsSilently = useEffectEvent(() => {
    void refreshLocalBoards({ silent: true });
  });

  const refreshRemoteBoardsSilently = useEffectEvent(() => {
    void refreshBoardsList({ silent: true });
  });

  function handleTreeDeleted(targetPath: string, type: FileTreeItemType, skipBroadcast?: boolean) {
    if (skipBroadcast) {
      return;
    }

    closeTabsForPath(targetPath, type);
    void refreshProjectIntegrity();
    refreshFileTree();
    pushToast(`Removed ${fileNameFromPath(targetPath)}`, 'info');
    void refreshGitChangeIndicator();
  }

  function handleTreeRenamed(oldPath: string, newPath: string) {
    remapOpenTabs(oldPath, newPath);
    void refreshProjectIntegrity();
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
    void refreshProjectIntegrity().then((integrity) => {
      const rootName = fileNameFromPath(createdPath).toLowerCase();
      if (integrity.conflictFiles.some((name) => name.toLowerCase() === rootName)) {
        pushToast('Only the Project entry file can define setup() or loop().', 'error', undefined, {
          detail: `${fileNameFromPath(createdPath)} is not the current entry point.`,
        });
      }
    });
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

    void refreshProjectIntegrity();
    refreshFileTree();
    void refreshGitChangeIndicator();
  }

  function handleTreeMoved() {
    void refreshProjectIntegrity();
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

  function getAgentChangeAbsolutePath(change: AgentChangePreview) {
    if (!workspacePath) {
      return change.path;
    }

    return joinPath(workspacePath, change.path);
  }

  function makeAgentPreviewTab(change: AgentChangePreview, reviewId: string, existingTab: FileTab | null): FileTab {
    const filePath = getAgentChangeAbsolutePath(change);
    const content = previewContentForAgentChange(change);
    const baseTab = existingTab ?? createSavedTab(filePath, content, { isPreview: false });

    return {
      ...baseTab,
      id: filePath,
      path: filePath,
      name: fileNameFromPath(filePath),
      content,
      savedContent: content,
      isDirty: false,
      isDeleted: change.changeType === 'delete',
      isPreviewFile: false,
      type: 'file' as const,
      fileState: 'saved',
      agentPreview: {
        reviewId,
        changeType: change.changeType,
        originalContent: change.originalContent,
        nextContent: change.nextContent,
        wasOpen: Boolean(existingTab),
      },
    };
  }

  function showAgentPreviewFile(change: AgentChangePreview, reviewId: string) {
    const filePath = getAgentChangeAbsolutePath(change);
    setSidebar('explorer');

    const existingTab = tabsRef.current.find((tab) => isSameFileTabPath(tab.path, filePath)) ?? null;
    const previewTab = makeAgentPreviewTab(change, reviewId, existingTab);
    const nextTabs = existingTab
      ? tabsRef.current.map((tab) => (isSameFileTabPath(tab.path, filePath) ? previewTab : tab))
      : openEditorTab(tabsRef.current, previewTab, { isPreview: false });

    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    activateTab(previewTab);
  }

  function getPreferredAgentPreviewChange(reviewFiles: AgentChangePreview[], incomingFiles: AgentChangePreview[]) {
    const incomingPaths = new Set(incomingFiles.map((file) => normalizeFileTabPath(file.path)));
    const incomingReviewFiles = reviewFiles.filter((file) => incomingPaths.has(normalizeFileTabPath(file.path)));

    return (
      incomingReviewFiles.find((file) => file.changeType !== 'delete') ??
      incomingReviewFiles[0] ??
      reviewFiles.find((file) => file.changeType !== 'delete') ??
      reviewFiles[0] ??
      null
    );
  }

  function openAgentReviewFilesInEditor(review: AgentPendingReview, incomingFiles: AgentChangePreview[]) {
    const preferredChange = getPreferredAgentPreviewChange(review.files, incomingFiles);
    if (!preferredChange) {
      return;
    }

    const incomingPaths = new Set(incomingFiles.map((file) => normalizeFileTabPath(file.path)));
    const changesToOpen = review.files.filter((file) => incomingPaths.has(normalizeFileTabPath(file.path)) && file.changeType !== 'delete');
    const visibleChanges = changesToOpen.length > 0 ? changesToOpen : [preferredChange];
    let nextTabs = tabsRef.current;

    setSidebar('explorer');

    for (const change of visibleChanges) {
      const filePath = getAgentChangeAbsolutePath(change);
      const existingTab = nextTabs.find((tab) => isSameFileTabPath(tab.path, filePath)) ?? null;
      const previewTab = makeAgentPreviewTab(change, review.id, existingTab);
      nextTabs = existingTab
        ? nextTabs.map((tab) => (isSameFileTabPath(tab.path, filePath) ? previewTab : tab))
        : openEditorTab(nextTabs, previewTab, { isPreview: false });
    }

    const preferredPath = getAgentChangeAbsolutePath(preferredChange);
    const activePreviewTab = nextTabs.find((tab) => isSameFileTabPath(tab.path, preferredPath)) ?? null;

    tabsRef.current = nextTabs;
    setTabs(nextTabs);

    if (activePreviewTab) {
      activateTab(activePreviewTab);
    }
  }

  function mergeAgentReviewFiles(currentFiles: AgentChangePreview[], incomingFiles: AgentChangePreview[]) {
    const fileMap = new Map(currentFiles.map((file) => [normalizeFileTabPath(file.path), file]));

    incomingFiles.forEach((incoming) => {
      const key = normalizeFileTabPath(incoming.path);
      const existing = fileMap.get(key);
      const originalContent = existing?.originalContent ?? incoming.originalContent;
      const wasCreatedInReview = existing?.changeType === 'create' || (!existing && incoming.changeType === 'create');
      const nextContent = incoming.nextContent;

      if (wasCreatedInReview && incoming.changeType === 'delete') {
        fileMap.delete(key);
        return;
      }

      if (!wasCreatedInReview && incoming.changeType !== 'delete' && nextContent === originalContent) {
        fileMap.delete(key);
        return;
      }

      fileMap.set(key, {
        ...incoming,
        changeType: wasCreatedInReview ? 'create' : incoming.changeType === 'delete' ? 'delete' : 'update',
        originalContent,
        nextContent,
        workspaceOriginalContent: existing?.workspaceOriginalContent ?? incoming.workspaceOriginalContent,
      });
    });

    return [...fileMap.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  function refreshAgentPreviewTabs(review: AgentPendingReview) {
    const reviewMap = new Map(review.files.map((file) => [normalizeFileTabPath(getAgentChangeAbsolutePath(file)), file]));
    const nextTabs = tabsRef.current.map((tab) => {
      const change = reviewMap.get(normalizeFileTabPath(tab.path));
      if (!change) {
        return tab.agentPreview?.reviewId === review.id ? { ...tab, agentPreview: undefined } : tab;
      }

      return makeAgentPreviewTab(change, review.id, tab);
    });

    tabsRef.current = nextTabs;
    setTabs(nextTabs);

    const activePath = activeTabIdRef.current;
    const activePreviewTab = activePath ? nextTabs.find((tab) => tab.id === activePath) : null;
    if (activePreviewTab) {
      editorValueRef.current = activePreviewTab.content;
      setEditorValue(activePreviewTab.content);
    }
  }

  function applyAgentRestoredFilesToEditorTabs(restoredFiles: AgentRestoredFile[]) {
    const restoredMap = new Map(restoredFiles.map((file) => [normalizeFileTabPath(file.absolutePath), file]));
    if (restoredMap.size === 0) {
      return;
    }

    const nextTabs = tabsRef.current
      .map((tab) => {
        const restored = restoredMap.get(normalizeFileTabPath(tab.path));
        const baseTab = stripFileTabAgentPreview(tab);
        if (!restored) {
          return baseTab;
        }

        if (!restored.exists || restored.isDirectory || restored.content === null) {
          return null;
        }

        return syncFileTabDirtyState({
          ...baseTab,
          content: restored.content,
          savedContent: restored.content,
          isDirty: false,
          isDeleted: false,
          fileState: 'saved' as FileTabState,
          type: 'file' as const,
        });
      })
      .filter((tab): tab is FileTab => Boolean(tab));

    tabsRef.current = nextTabs;
    setTabs(nextTabs);

    const activePath = activeTabIdRef.current;
    const nextActiveTab = (activePath ? nextTabs.find((tab) => tab.id === activePath || isSameFileTabPath(tab.path, activePath)) : null) ?? nextTabs[0] ?? null;
    activeTabIdRef.current = nextActiveTab?.id ?? null;
    editorValueRef.current = nextActiveTab?.content ?? '';
    setActiveTabId(nextActiveTab?.id ?? null);
    setEditorValue(nextActiveTab?.content ?? '');
  }

  function handleAgentChangesPrepared(review: AgentPreparedReview) {
    if (!workspacePath || review.files.length === 0) {
      return;
    }

    refreshFileTree();
    void refreshGitChangeIndicator();

    const previousReview = pendingAgentReview;
    const reviewId = previousReview?.id ?? `agent-review-${agentReviewIdCounterRef.current++}`;
    const mergedFiles = mergeAgentReviewFiles(previousReview?.files ?? [], review.files);
    const nextReview: AgentPendingReview = {
      ...review,
      id: reviewId,
      threadId: previousReview?.threadId ?? review.threadId,
      files: mergedFiles,
      createdAt: previousReview?.createdAt ?? new Date().toISOString(),
    };

    if (nextReview.files.length === 0) {
      setPendingAgentReview(null);
      clearAgentPreviewTabs(
        {
          ...nextReview,
          files: previousReview?.files ?? [],
        },
        false,
      );
      pushToast('Tantalum AI changes returned to the live baseline.', 'info');
      return;
    }

    setPendingAgentReview(nextReview);
    refreshAgentPreviewTabs(nextReview);
    openAgentReviewFilesInEditor(nextReview, review.files);
    if (review.userMessageId) {
      void window.tantalum.agent.recordRestorePoint({
        workspacePath,
        threadId: review.threadId,
        userMessageId: review.userMessageId,
        userMessageCreatedAt: review.userMessageCreatedAt ?? null,
        reviewId,
        status: 'pending',
        files: review.files,
      }).then((result) => {
        if (result.success) {
          setAgentRestorePoints(result.restorePoints);
        } else {
          pushToast(result.error, 'error');
        }
      });
    }
    pushToast(`${nextReview.files.length} Tantalum AI ${nextReview.files.length === 1 ? 'change' : 'changes'} applied. Keep or revert them in the editor.`, 'info');
  }

  function clearAgentDiffDecorations() {
    agentDiffDecorationsRef.current?.clear();
    agentDiffDecorationsRef.current = null;

    const editorInstance = editorRef.current;
    const zoneIds = agentDiffViewZoneIdsRef.current;
    if (editorInstance && zoneIds.length > 0) {
      editorInstance.changeViewZones((accessor) => {
        zoneIds.forEach((zoneId) => accessor.removeZone(zoneId));
      });
    }

    agentDiffViewZoneIdsRef.current = [];
  }

  function createDeletedViewZoneNode(lines: string[]) {
    const node = document.createElement('div');
    node.className = 'agent-diff-deleted-zone';

    lines.forEach((line) => {
      const row = document.createElement('div');
      row.className = 'agent-diff-deleted-zone-line';

      const marker = document.createElement('span');
      marker.className = 'agent-diff-zone-marker';
      marker.textContent = '-';

      const code = document.createElement('code');
      code.textContent = line || ' ';

      row.append(marker, code);
      node.append(row);
    });

    return node;
  }

  function renderAgentDiffDecorations(change: AgentChangePreview | null) {
    clearAgentDiffDecorations();

    const editorInstance = editorRef.current;
    const monaco = monacoRef.current;
    const model = editorInstance?.getModel();
    if (!change || !editorInstance || !monaco || !model) {
      return;
    }

    const decorations: editor.IModelDeltaDecoration[] = [];
    const deletedChunks: Array<{ afterLineNumber: number; lines: string[] }> = [];

    if (change.changeType === 'delete') {
      const lineCount = Math.max(1, model.getLineCount());
      for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
        decorations.push({
          range: new monaco.Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)),
          options: {
            isWholeLine: true,
            className: 'agent-diff-deleted-line',
            overviewRuler: {
              color: 'rgba(248, 81, 73, 0.8)',
              position: monaco.editor.OverviewRulerLane.Right,
            },
          },
        });
      }
    } else {
      let lastNewLine = 0;
      let activeDeletedChunk: { afterLineNumber: number; lines: string[] } | null = null;

      buildAgentDiffRows(change).forEach((row) => {
        if (row.kind === 'add' && row.newLine) {
          activeDeletedChunk = null;
          lastNewLine = row.newLine;
          decorations.push({
            range: new monaco.Range(row.newLine, 1, row.newLine, model.getLineMaxColumn(row.newLine)),
            options: {
              isWholeLine: true,
              className: 'agent-diff-added-line',
              overviewRuler: {
                color: 'rgba(46, 160, 67, 0.8)',
                position: monaco.editor.OverviewRulerLane.Right,
              },
            },
          });
          return;
        }

        if (row.kind === 'delete') {
          if (!activeDeletedChunk) {
            activeDeletedChunk = {
              afterLineNumber: lastNewLine,
              lines: [],
            };
            deletedChunks.push(activeDeletedChunk);
          }
          activeDeletedChunk.lines.push(row.text);
          return;
        }

        activeDeletedChunk = null;
        if (row.newLine) {
          lastNewLine = row.newLine;
        }
      });
    }

    agentDiffDecorationsRef.current = editorInstance.createDecorationsCollection(decorations);
    editorInstance.changeViewZones((accessor) => {
      agentDiffViewZoneIdsRef.current = deletedChunks.map((chunk) =>
        accessor.addZone({
          afterLineNumber: chunk.afterLineNumber,
          heightInLines: Math.max(1, chunk.lines.length),
          domNode: createDeletedViewZoneNode(chunk.lines),
          suppressMouseDown: true,
        }),
      );
    });
  }

  function clearAgentPreviewTabs(review: AgentPendingReview, approved: boolean) {
    const reviewPaths = new Set(review.files.map((file) => normalizeFileTabPath(getAgentChangeAbsolutePath(file))));
    const nextTabs = tabsRef.current.flatMap((tab) => {
      if (!reviewPaths.has(normalizeFileTabPath(tab.path)) || tab.agentPreview?.reviewId !== review.id) {
        return [tab];
      }

      if (!approved && (!tab.agentPreview.wasOpen || tab.agentPreview.changeType === 'create')) {
        return [];
      }

      if (approved && tab.agentPreview.changeType === 'delete') {
        return [];
      }

      const content = approved ? tab.agentPreview.nextContent : tab.agentPreview.originalContent;
      return [
        {
          ...tab,
          content,
          savedContent: content,
          isDirty: false,
          isDeleted: false,
          agentPreview: undefined,
          fileState: 'saved' as FileTabState,
          type: 'file' as const,
        },
      ];
    });

    tabsRef.current = nextTabs;
    setTabs(nextTabs);

    const nextActiveTab = (activeTabIdRef.current ? nextTabs.find((tab) => tab.id === activeTabIdRef.current) : null) ?? nextTabs[0] ?? null;
    activeTabIdRef.current = nextActiveTab?.id ?? null;
    editorValueRef.current = nextActiveTab?.content ?? '';
    setActiveTabId(nextActiveTab?.id ?? null);
    setEditorValue(nextActiveTab?.content ?? '');
  }

  async function writeAgentReviewNotice(review: AgentPendingReview, content: string, tone: AgentReviewResolutionNotice['tone']) {
    try {
      const saved = await createAgentThreadMessage({
        threadId: review.threadId,
        role: 'status',
        content,
        tone,
      });

      setAgentReviewNotice({
        id: saved.id,
        threadId: review.threadId,
        content: saved.content,
        tone: saved.tone,
        createdAt: saved.createdAt ?? new Date().toISOString(),
      });
    } catch {
      setAgentReviewNotice({
        id: `agent-review-notice-${agentReviewNoticeCounterRef.current++}`,
        threadId: review.threadId,
        content,
        tone,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async function resolvePendingAgentReview(approved: boolean) {
    if (!pendingAgentReview || !workspacePath || resolvingAgentReview) {
      return;
    }

    const review = pendingAgentReview;
    setResolvingAgentReview(true);

    try {
      for (const change of review.files) {
        const targetPath = getAgentChangeAbsolutePath(change);
        if (!isPathInsideRoot(targetPath, workspacePath)) {
          throw new Error(`Blocked unsafe agent change: ${change.path}`);
        }
      }

      if (!approved) {
        for (const change of review.files) {
          const targetPath = getAgentChangeAbsolutePath(change);
          if (change.changeType === 'create') {
            const current = await window.tantalum.fs.readFile(targetPath);
            if (current.success && current.content !== change.nextContent) {
              throw new Error(`${change.path} changed after Tantalum AI applied it. Keep it or manually resolve this file.`);
            }

            if (current.success) {
              const result = await window.tantalum.fs.deletePath(targetPath);
              if (!result.success) {
                throw new Error(result.error);
              }
            }
            continue;
          }

          if (change.changeType === 'update') {
            const current = await window.tantalum.fs.readFile(targetPath);
            if (!current.success) {
              throw new Error(current.error);
            }

            if (current.content !== change.nextContent) {
              throw new Error(`${change.path} changed after Tantalum AI applied it. Keep it or manually resolve this file.`);
            }
          }

          const result = await window.tantalum.fs.writeFile(targetPath, change.originalContent);

          if (!result.success) {
            throw new Error(result.error);
          }
        }
      }

      clearAgentPreviewTabs(review, approved);
      setPendingAgentReview(null);
      const restoreStatusResult = await window.tantalum.agent.updateRestoreReviewStatus({
        workspacePath,
        reviewId: review.id,
        status: approved ? 'kept' : 'reverted',
      });
      if (restoreStatusResult.success) {
        setAgentRestorePoints(restoreStatusResult.restorePoints);
      } else {
        pushToast(restoreStatusResult.error, 'error');
      }
      refreshFileTree();
      void refreshGitChangeIndicator();

      const content = approved
        ? `Kept ${review.files.length} Tantalum AI ${review.files.length === 1 ? 'change' : 'changes'}.`
        : `Reverted ${review.files.length} Tantalum AI ${review.files.length === 1 ? 'change' : 'changes'}.`;
      await writeAgentReviewNotice(review, content, approved ? 'success' : 'warning');
      pushToast(content, approved ? 'success' : 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to resolve Tantalum AI changes.';
      await writeAgentReviewNotice(review, message, 'error');
      pushToast(message, 'error');
    } finally {
      setResolvingAgentReview(false);
    }
  }

  async function restoreAgentThreadToMessage(message: AgentThreadMessage, currentMessages: AgentThreadMessage[]) {
    if (!workspacePath) {
      throw new Error('Open a Project before restoring agent changes.');
    }

    const userMessageIds = currentMessages.filter((entry) => entry.role === 'user').map((entry) => entry.id);
    const restoreResult = await window.tantalum.agent.restoreToMessage({
      workspacePath,
      threadId: message.threadId,
      messageId: message.id,
      messageIdsInOrder: userMessageIds,
    });
    if (!restoreResult.success) {
      throw new Error(restoreResult.error);
    }

    applyAgentRestoredFilesToEditorTabs(restoreResult.restoredFiles);
    if (pendingAgentReview?.threadId === message.threadId) {
      setPendingAgentReview(null);
    }
    setAgentRestorePoints(restoreResult.restorePoints);
    refreshFileTree();
    void refreshGitChangeIndicator();
    const truncateResult = await truncateAgentThreadMessages(message.threadId, message.id);

    const restoredCount = restoreResult.restoredFiles.length;
    const content = `Restored ${restoredCount} agent-touched ${restoredCount === 1 ? 'file' : 'files'} and removed ${truncateResult.removedCount} later ${truncateResult.removedCount === 1 ? 'message' : 'messages'}.`;
    pushToast(content, 'success');
    pushConsole(content, 'success');

    return {
      messages: truncateResult.messages,
      restorePoints: restoreResult.restorePoints,
    };
  }

  const activeExplorerPath = activeTab && !activeTab.path.startsWith('untitled:') ? activeTab.path : null;
  const activeProjectExplorerPath =
    activeExplorerPath && selectedProject?.exists && isPathInsideRoot(activeExplorerPath, selectedProject.path) ? activeExplorerPath : null;
  const currentTerminalFolderPath = activeTab && !activeTab.path.startsWith('untitled:') ? parentPath(activeTab.path) : workspacePath;
  const isTerminalWorkspaceActive = sidebar === 'terminal';
  const renderLegacyLeftTools = false;
  const isConsoleVisible = bottomPanelOpen && !isTerminalWorkspaceActive;
  const consoleViewLabel = consoleView === 'serial' ? 'Serial Monitor' : consoleView === 'terminal' ? 'Terminal' : 'Output';
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
    toastsRef.current = toasts;
  }, [toasts]);

  useEffect(() => {
    if (!restoreToolchainNotificationRequest) {
      return;
    }

    restoreToolchainNotificationToast(restoreToolchainNotificationRequest.notification);
  }, [restoreToolchainNotificationRequest]);

  useEffect(() => {
    const offNotifications = window.tantalum.notifications.onChanged((notifications) => {
      showAgentToolchainNotificationToasts(notifications);
    });

    return offNotifications;
  }, []);

  useEffect(() => {
    panelSizesRef.current = panelSizes;
  }, [panelSizes]);

  useEffect(() => {
    workspaceActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    workspacePathRef.current = workspacePath;
  }, [workspacePath]);

  useEffect(() => {
    projectIntegrityRef.current = projectIntegrity;
  }, [projectIntegrity]);

  useEffect(() => {
    tabsRef.current = syncedTabs;
  }, [syncedTabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    editorValueRef.current = editorValue;
  }, [editorValue]);

  useEffect(() => () => {
    editorSelectionDisposableRef.current?.dispose();
    editorSelectionDisposableRef.current = null;
  }, []);

  useEffect(() => {
    refreshActiveEditorSelection();
  }, [activeTab?.agentPreview, activeTab?.path, editorReady, editorValue, refreshActiveEditorSelection]);

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
      renderAgentDiffDecorations(activeAgentChange);
    }, 0);

    return () => {
      window.clearTimeout(handle);
      clearAgentDiffDecorations();
    };
  }, [activeAgentChange, activeTab?.path, editorReady]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      refreshActiveEditorDiagnostics(activeEditorFilePath);
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [activeEditorFilePath, activeEditorLanguage, projectIntegrity.entryFile, projectIntegrity.error, projectIntegrity.loading, refreshActiveEditorDiagnostics]);

  useEffect(() => {
    if (!workspacePath || !activeEditorFilePath || !isRootInoProjectFile(activeEditorFilePath, workspacePath)) {
      return;
    }

    const handle = window.setTimeout(() => {
      void refreshProjectIntegrity(workspacePath).then(() => refreshFileTree());
    }, 250);

    return () => {
      window.clearTimeout(handle);
    };
  // The integrity scanner reads current refs so the live check does not need to
  // restart for every helper function identity change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditorFilePath, editorValue, workspacePath]);

  useEffect(() => {
    handleSelectedBoardChange(selectedBoard);
  }, [selectedBoardId, selectedBoard]);

  useEffect(() => {
    writeStoredSelectedLocalBoardId(selectedLocalBoardId);
  }, [selectedLocalBoardId]);

  useEffect(() => {
    if (parsedEditorBoardSelection.kind === 'local' && localBoardRows.some((row) => row.profileId === parsedEditorBoardSelection.id)) {
      return;
    }

    if (parsedEditorBoardSelection.kind === 'cloud' && boards.some((board) => board.$id === parsedEditorBoardSelection.id)) {
      return;
    }

    const nextSelection = selectedLocalBoard?.profileId
      ? editorLocalBoardValue(selectedLocalBoard.profileId)
      : selectedBoard?.$id
        ? editorCloudBoardValue(selectedBoard.$id)
        : '';

    if (nextSelection !== editorBoardSelection) {
      setEditorBoardSelection(nextSelection);
    }
  }, [boards, editorBoardSelection, localBoardRows, parsedEditorBoardSelection.id, parsedEditorBoardSelection.kind, selectedBoard?.$id, selectedLocalBoard?.profileId]);

  useEffect(() => {
    const savedRows = localBoardRows.filter((row) => row.profileId);
    if (savedRows.length === 0) {
      if (selectedLocalBoardId) {
        setSelectedLocalBoardId('');
      }
      return;
    }

    if (savedRows.some((row) => row.profileId === selectedLocalBoardId)) {
      return;
    }

    const nextSelectedRow = savedRows.find((row) => row.connected) ?? savedRows[0];
    setSelectedLocalBoardId(nextSelectedRow.profileId ?? '');
  }, [localBoardRows, selectedLocalBoardId]);

  useEffect(() => {
    if (!active || (sidebar !== 'boards' && !hasConfiguredLocalBoard)) {
      return;
    }

    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      refreshLocalBoardsSilently();
    };

    const refreshInterval = window.setInterval(refresh, LOCAL_BOARD_AUTO_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, hasConfiguredLocalBoard, sidebar]);

  useEffect(() => {
    if (!active || !hasRequiredCloudConfiguration()) {
      return;
    }

    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      refreshRemoteBoardsSilently();
    };

    const refreshInterval = window.setInterval(refresh, REMOTE_BOARD_AUTO_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active]);

  useEffect(() => {
    if (!autoScrollLogs || !consoleOutputRef.current) {
      return;
    }

    consoleOutputRef.current.scrollTop = consoleOutputRef.current.scrollHeight;
  }, [consoleEntries, autoScrollLogs]);

  useEffect(() => {
    return () => {
      if (localBoardMonitoringResumeTimerRef.current !== null) {
        window.clearTimeout(localBoardMonitoringResumeTimerRef.current);
      }
      clearFirmwareReleaseProgressTimer(firmwareReleaseProgressRef.current);
      firmwareReleaseProgressRef.current = null;
    };
  }, []);

  useEffect(() => {
    void initializeWorkspace();

    const offMenu = window.tantalum.app.onMenuAction((action) => {
      void handleMenuAction(action);
    });
    const offProgress = window.tantalum.toolchain.onInstallProgress((chunk) => {
      handleInstallProgress(chunk);
    });
    const offCompileProgress = window.tantalum.toolchain.onCompileProgress((event) => {
      handleCompileProgress(event);
    });
    const offStorageUploadProgress = window.tantalum.cloud.storage.onUploadProgress((event) => {
      handleStorageUploadProgress(event);
    });
    const offUsbUploadProgress = window.tantalum.toolchain.onUsbUploadProgress((event) => {
      handleUsbUploadProgress(event);
    });
    const offBoardCodeProgress = window.tantalum.toolchain.onBoardCodeProgress((event) => {
      handleBoardCodeProgress(event);
    });
    const offLibraryProgress = window.tantalum.toolchain.onLibraryInstallProgress((event) => {
      handleLibraryInstallProgress(event);
    });
    const offLibraryMigrationProgress = window.tantalum.toolchain.onLibraryMigrationProgress((event) => {
      handleLibraryMigrationProgress(event);
    });

    return () => {
      offMenu();
      offProgress();
      offCompileProgress();
      offStorageUploadProgress();
      offUsbUploadProgress();
      offBoardCodeProgress();
      offLibraryProgress();
      offLibraryMigrationProgress();
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
    if (sidebar === 'libraries' || sidebar === 'platforms') {
      ensureManagerDetailPanelVisible();
    }
  }, [ensureManagerDetailPanelVisible, sidebar]);

  useEffect(() => {
    if (sidebar !== 'libraries') {
      return;
    }

    if (libraryManagerTab === 'installed') {
      setLibrariesLoading(false);
      setLibrariesError(null);
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
  }, [sidebar, libraryManagerTab, librarySearchTerm, defaultLibraryResults]);

  useEffect(() => {
    if (sidebar !== 'libraries' || librarySearchTerm) {
      return;
    }

    const librariesNeedingMetadata = defaultLibraryResults
      .filter((library) => (library.versions?.length ?? 0) === 0 || !library.website)
      .slice(0, 6);

    librariesNeedingMetadata.forEach((library) => {
      void ensureLibraryMetadata(library);
    });
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
    refreshActiveEditorDiagnostics(activeEditorFilePath);
    editorSelectionDisposableRef.current?.dispose();
    editorSelectionDisposableRef.current = editorInstance.onDidChangeCursorSelection(() => {
      refreshActiveEditorSelection();
    });
    editorInstance.focus();
    setEditorReady(true);
    window.requestAnimationFrame(refreshActiveEditorSelection);
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
    const linkableLocalBoards = localBoardRows.filter((row) => row.profileId && isCloudCapableBoardFqbn(row.fqbn));
    const needsRuntimeInstall = liveStatus === 'pending' || !selectedBoard.lastSeen || !selectedBoard.runtimeVersion;
    const canOpenRemoteWifiSetup = liveStatus === 'online';
    const canInstallFromLinkedLocal = Boolean(selectedBoardLinkedLocalRow?.profile && (selectedBoardLinkedLocalRow.port || selectedBoardLinkedLocalRow.fingerprint));
    const linkedLocalInstallBusy = selectedBoardLinkedLocalRow ? busyAction === `install-cloud-runtime:${selectedBoardLinkedLocalRow.key}` : false;

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
              <dt>OTA status</dt>
              <dd>{selectedBoard.otaStatus || 'idle'}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{selectedBoard.runtimeVersion || 'Not reported'}</dd>
            </div>
            <div>
              <dt>Provisioning code</dt>
              <dd>{selectedBoardSecrets?.provisioningPop || selectedBoard.provisioningPop || 'Missing locally'}</dd>
            </div>
            <div>
              <dt>Token preview</dt>
              <dd>••••••{selectedBoard.tokenPreview || 'n/a'}</dd>
            </div>
            <div>
              <dt>Local secrets</dt>
              <dd>{selectedBoardSecrets?.apiToken && selectedBoardSecrets?.commandSecret && selectedBoardSecrets?.mqttTopic ? 'Available on this machine' : 'Missing locally'}</dd>
            </div>
            <div>
              <dt>WiFi credentials</dt>
              <dd>Stored only on board</dd>
            </div>
            <div>
              <dt>Local link</dt>
              <dd>{selectedBoardLinkedLocalRow ? `${localBoardDisplayName(selectedBoardLinkedLocalRow)} on ${selectedBoardLinkedLocalRow.port || 'saved port'}` : 'Not linked'}</dd>
            </div>
            <div>
              <dt>Code visibility</dt>
              <dd>{selectedBoard.sourceCodeVisibility === 'public' ? 'Public to signed-in users' : 'Private'}</dd>
            </div>
          </dl>
          <div className="inline-banner">
            Your WiFi name and password are sent directly over USB, Bluetooth, or SoftAP to the board. They are not uploaded to Tantalum Cloud and are not stored by the IDE.
          </div>
          <div className="compound-row">
            <select value={selectedLinkLocalProfileId} onChange={(event) => setSelectedLinkLocalProfileId(event.target.value)}>
              <option value="">Select local board link</option>
              {linkableLocalBoards.map((row) => (
                <option key={row.profileId} value={row.profileId}>
                  {localBoardDisplayName(row)}{row.port ? ` (${row.port})` : ''}
                </option>
              ))}
            </select>
            <button className="secondary-button compact" type="button" onClick={() => void handleLinkSelectedCloudBoardToLocal()} disabled={Boolean(busyAction?.startsWith('link-cloud-board')) || !selectedLinkLocalProfileId}>
              <Link2 size={14} />
              Link local
            </button>
          </div>
          {selectedBoard.lastOtaError ? <div className="inline-banner inline-banner-warning">{selectedBoard.lastOtaError}</div> : null}
          {needsRuntimeInstall ? (
            <div className="inline-banner inline-banner-warning">
              Tantalum Cloud install needed. Select or connect the matching local board, link it here, then install Tantalum Cloud over USB.
            </div>
          ) : null}
          <div className="action-row">
            <button
              className="secondary-button"
              type="button"
              onClick={() => openBoardCodeDestination(remoteBoardCodeTarget(selectedBoard, selectedBoardLinkedLocalRow))}
              disabled={busyAction === 'view-code'}
            >
              <FileCode2 size={14} />
              View code
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void handleSetCloudBoardCodeVisibility(selectedBoard, selectedBoard.sourceCodeVisibility === 'public' ? 'private' : 'public')}
              disabled={busyAction === `code-visibility:${selectedBoard.$id}`}
              title={selectedBoard.sourceCodeVisibility === 'public' ? 'Only your account can restore future snapshots after switching to private.' : 'Any signed-in Tantalum account can restore snapshots from this board marker after switching to public.'}
            >
              {busyAction === `code-visibility:${selectedBoard.$id}` ? <LoaderCircle size={14} className="spin" /> : null}
              Code {selectedBoard.sourceCodeVisibility === 'public' ? 'public' : 'private'}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                if (selectedBoardLinkedLocalRow?.profileId) {
                  setPendingCloudRuntimeInstall({ profileId: selectedBoardLinkedLocalRow.profileId, boardId: selectedBoard.$id });
                }
              }}
              disabled={!hasDeviceGatewayFunction() || !canInstallFromLinkedLocal || linkedLocalInstallBusy}
              title={!canInstallFromLinkedLocal ? 'Link the matching local board before installing Tantalum Cloud.' : undefined}
            >
              {linkedLocalInstallBusy ? 'Installing...' : 'Install Tantalum Cloud'}
            </button>
            <button className="secondary-button" type="button" onClick={() => void handleRequestBoardProvisioning()} disabled={busyAction === 'start-provisioning' || !hasBoardAdminFunction() || !canOpenRemoteWifiSetup}>
              Open WiFi setup
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
              Add `VITE_APPWRITE_DEVICE_GATEWAY_FUNCTION_ID` before installing Tantalum Cloud so OTA updates can work.
            </div>
          ) : null}
          {selectedBoardLinkedLocalRow && !canInstallFromLinkedLocal ? (
            <div className="inline-banner inline-banner-warning">
              Linked local board is not connected over USB. Connect {localBoardDisplayName(selectedBoardLinkedLocalRow)}; the IDE will refresh the live port before installing Tantalum Cloud.
            </div>
          ) : null}
          {!selectedBoardLinkedLocalRow ? (
            <div className="inline-banner">
              Install Tantalum Cloud requires a linked local board. Select a connected local board and link it first.
            </div>
          ) : null}
          {!canOpenRemoteWifiSetup ? (
            <div className="inline-banner">
              Board is not online. Send WiFi directly over USB, or use BLE/SoftAP provisioning from mobile.
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
                      {firmware.deployed ? <span className="release-badge">Desired</span> : null}
                    </div>
                    <p>{firmware.filename}</p>
                    <small>{formatBytes(firmware.size)} • {new Date(firmware.uploadedAt).toLocaleString()}</small>
                  </div>
                  <div className="release-actions">
                    {!firmware.deployed ? (
                      <button className="secondary-button compact" type="button" onClick={() => void handlePromoteFirmware(firmware)}>
                        Deploy
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

  function renderLocalBoardCard(row: LocalBoardRow, portOptions: LocalBoardPort[]) {
    const displayName = localBoardDisplayName(row);
    const commonBoardOptions = BOARD_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
    const commonBoardValues = new Set(commonBoardOptions.map((option) => option.value));
    const detectedBoardOptions = uniqueBoardOptions(
      (row.matchingBoards ?? [])
        .filter((match) => isUploadableBoardFqbn(match.fqbn) && !match.isHidden)
        .map((match) => ({ value: match.fqbn, label: match.name || match.fqbn })),
    ).filter((option) => !commonBoardValues.has(option.value));
    const visibleSelectValues = new Set([...commonBoardOptions, ...detectedBoardOptions].map((option) => option.value));
    const currentBoardOption =
      isUploadableBoardFqbn(row.fqbn) && !visibleSelectValues.has(row.fqbn)
        ? { value: row.fqbn, label: row.boardLabel || row.fqbn }
        : null;
    const selectBoardOptions = uniqueBoardOptions([
      ...commonBoardOptions,
      ...detectedBoardOptions,
      ...(currentBoardOption ? [currentBoardOption] : []),
    ]);
    const selectBoardType = (fqbn: string) => {
      const selectedOption = selectBoardOptions.find((option) => option.value === fqbn) ?? localBoardCatalog.find((option) => option.value === fqbn);
      updateLocalBoardEdit(row.key, { fqbn, boardLabel: selectedOption?.label || fqbn });
    };

    const chooseInstalledBoard = (option: LocalBoardOption) => {
      updateLocalBoardEdit(row.key, { fqbn: option.value, boardLabel: option.label });
      setLocalBoardAdvancedOpenKey(null);
      setLocalBoardCatalogQuery('');
    };

    const exactChipProbe = row.detectionSource === 'esptool-chip-probe';
    const hasDetectionHint = row.matchingBoards?.some((match) => match.isHidden || isNonUploadableBoardFqbn(match.fqbn));
    const needsReview = !isUploadableBoardFqbn(row.fqbn) || row.ai?.status === 'suggested';
    const shouldShowAccuracyAdvisory =
      row.connected &&
      isUploadableBoardFqbn(row.fqbn) &&
      !exactChipProbe &&
      !isOfficialArduinoBoardFqbn(row.fqbn);
    const statusText = row.connected ? (row.portChanged ? 'port changed' : needsReview ? 'needs review' : 'connected') : row.profileId ? 'disconnected' : 'not set';
    const statusClass = row.connected ? (row.portChanged || needsReview ? 'pending' : 'online') : row.profileId ? 'offline' : 'pending';
    const canUseBoard = isUploadableBoardFqbn(row.fqbn) && Boolean(row.port);
    const aiMessage =
      row.ai?.status && row.ai.status !== 'suggested' && row.ai.status !== 'no-suggestion'
        ? row.ai.reason || 'Board detection AI is unavailable.'
        : null;

    const portOptionMap = new Map<string, LocalBoardPort>();
    const addPortOption = (port: LocalBoardPort | null) => {
      if (port?.path && !portOptionMap.has(port.path)) {
        portOptionMap.set(port.path, port);
      }
    };
    portOptions.forEach(addPortOption);
    addPortOption(portOptionFromBoard(row));
    const fullPortOptions = Array.from(portOptionMap.values()).sort(compareLocalBoardPorts);
    const liveSelectedPort = row.port
      ? localBoardPorts.find((port) => normalizeLocalBoardHardwareValue(port.path) === normalizeLocalBoardHardwareValue(row.port)) ?? null
      : null;
    const selectedPortIsKnownGeneric = Boolean(liveSelectedPort && liveSelectedPort.likelyBoard === false);
    const saveBusy = busyAction === `save-local-board:${row.key}`;
    const deleteBusy = busyAction === `delete-local-board:${row.key}`;
    const makeCloudBusy = busyAction === `make-cloud-board:${row.key}`;
    const installCloudBusy = busyAction === `install-cloud-runtime:${row.key}`;
    const isExpanded = Boolean(expandedLocalBoardKeys[row.key]);
    const isSelected = Boolean(row.profileId && row.profileId === selectedLocalBoardId);
    const advancedOpen = localBoardAdvancedOpenKey === row.key;
    const linkedCloudBoard = row.cloudBoardId ? boards.find((board) => board.$id === row.cloudBoardId) ?? null : null;
    const linkedCloudStatus = linkedCloudBoard ? calculateBoardStatus(linkedCloudBoard.lastSeen, linkedCloudBoard.status) : null;
    const likelyCloudBoard = !row.cloudBoardId ? findLikelyCloudBoardForLocal(row, boards, selectedBoardId) : null;
    const cloudLinkMissing = Boolean(row.cloudBoardId && !linkedCloudBoard);
    const linkCloudBusy = busyAction === `link-cloud-board:${row.key}` || busyAction === `install-cloud-runtime:${row.key}`;
    const canResolveUsbPort = Boolean(row.port || row.fingerprint);
    const canEnableTantalumCloud = Boolean(row.profileId && isCloudCapableBoardFqbn(row.fqbn) && canResolveUsbPort);
    const canInstallTantalumCloud = Boolean(row.profileId && row.cloudBoardId && linkedCloudBoard && canResolveUsbPort);

    return (
      <article key={row.key} className={`local-board-card ${isSelected ? 'active' : ''} ${row.connected ? 'connected' : 'disconnected'}`}>
        <button className="local-board-card-head local-board-accordion-trigger" type="button" aria-expanded={isExpanded} onClick={() => toggleLocalBoardExpanded(row.key)}>
          <div>
            <strong>{displayName}</strong>
            <span>{row.boardLabel || row.fqbn || 'Board type not set'}{row.port ? ` • ${row.port}` : ' • No port selected'}</span>
          </div>
          <span className="local-board-summary-badges">
            {isSelected ? <span className="release-badge">Selected</span> : null}
            {row.cloudBoardId ? <span className="release-badge">Cloud linked</span> : null}
            {row.lastCloudProvisionedAt ? <span className="release-badge">Tantalum Cloud installed</span> : null}
            {row.cloudBoardId && !row.lastCloudProvisionedAt ? <span className="release-badge">Tantalum Cloud install needed</span> : null}
            {!row.cloudBoardId && likelyCloudBoard ? <span className="release-badge">Cloud link missing</span> : null}
            {!row.cloudBoardId && !likelyCloudBoard && isCloudCapableBoardFqbn(row.fqbn) ? <span className="release-badge">Plain local upload</span> : null}
            <span className={`status-pill status-${statusClass}`}>{statusText}</span>
            {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </button>

        <div className="local-board-meta">
          <span>{row.manufacturer || 'Unknown manufacturer'}</span>
          <span>{localBoardConfidenceText(row)}</span>
          {linkedCloudBoard ? <span>Cloud {linkedCloudStatus}</span> : null}
          {cloudLinkMissing ? <span>Cloud link missing</span> : null}
          {likelyCloudBoard ? <span>Likely cloud board: {likelyCloudBoard.name}</span> : null}
          {row.ai?.status === 'suggested' ? <span>AI suggested</span> : null}
        </div>

        {isExpanded ? (
          <>
            {aiMessage ? <div className="manager-inline-status manager-inline-error">{aiMessage}</div> : null}
            {row.matchingBoards && row.matchingBoards.length > 1 && !exactChipProbe ? (
              <div className="manager-inline-status">Multiple board matches found. Confirm the board type before saving.</div>
            ) : null}
            {hasDetectionHint && !exactChipProbe ? (
              <div className="manager-inline-status">
                ESP32 Family Device is a detection hint, not an upload target. Select the exact board type, for example ESP32-C3.
              </div>
            ) : null}
            {exactChipProbe ? <div className="manager-inline-status">Auto scan identified the ESP chip family from the board bootloader.</div> : null}
            {shouldShowAccuracyAdvisory ? (
              <div className="manager-inline-status">
                Auto scan is an advisory match for this board type. If this is a clone or vendor-specific board, confirm the exact board in Advanced search before uploading.
              </div>
            ) : null}
            {selectedPortIsKnownGeneric && !row.connected ? (
              <div className="manager-inline-status">
                {row.port} is available as a serial port, but it is not detected as a board. Select a USB board port or run Auto detect.
              </div>
            ) : null}
            {row.portChanged && row.stalePort ? (
              <div className="manager-inline-status">
                USB port changed from {row.stalePort} to {row.port}. The IDE will use the live port for USB actions.
              </div>
            ) : null}
            {linkedCloudBoard ? (
              <div className="manager-inline-status">
                Linked to cloud board {linkedCloudBoard.name}. Wired uploads keep the Tantalum cloud runtime installed.
              </div>
            ) : null}
            {linkedCloudBoard && !row.lastCloudProvisionedAt ? (
              <div className="manager-inline-status">
                Tantalum Cloud install needed. Install it to enable heartbeat, OTA updates, and secure WiFi provisioning.
              </div>
            ) : null}
            {!row.cloudBoardId && isCloudCapableBoardFqbn(row.fqbn) && (!row.connected || !row.port) ? (
              <div className="manager-inline-status">
                Connect and save this board over USB before enabling Tantalum Cloud.
              </div>
            ) : null}
            {cloudLinkMissing ? (
              <div className="manager-inline-status manager-inline-error">
                This saved local board has a cloud link, but that remote board is not in the current list. Refresh cloud boards or relink before uploading.
              </div>
            ) : null}
            {likelyCloudBoard ? (
              <div className="manager-inline-status">
                This looks like cloud board {likelyCloudBoard.name}. Link it before USB upload to keep OTA and provisioning installed.
              </div>
            ) : null}

            <div className="local-board-fields">
              <label>
                Name
                <input value={row.name} onChange={(event) => updateLocalBoardEdit(row.key, { name: event.target.value })} placeholder={row.boardLabel || 'Workbench board'} />
              </label>
              <label>
                Board type
                <select value={row.fqbn} onChange={(event) => selectBoardType(event.target.value)}>
                  <option value="">Select exact board type</option>
                  <optgroup label="Common boards">
                    {commonBoardOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                  {detectedBoardOptions.length > 0 ? (
                    <optgroup label="Detected candidates">
                      {detectedBoardOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {currentBoardOption ? (
                    <optgroup label="Current selection">
                      <option value={currentBoardOption.value}>{currentBoardOption.label}</option>
                    </optgroup>
                  ) : null}
                </select>
              </label>
              <div className="local-board-advanced-toggle">
                <button className="secondary-button compact" type="button" onClick={() => handleToggleLocalBoardAdvanced(row.key)}>
                  <Search size={13} />
                  {advancedOpen ? 'Hide installed boards' : 'Advanced board search'}
                </button>
              </div>
              {advancedOpen ? (
                <div className="local-board-advanced">
                  <div className="search-strip local-board-search-strip">
                    <Search size={16} />
                    <input value={localBoardCatalogQuery} onChange={(event) => setLocalBoardCatalogQuery(event.target.value)} placeholder="Search installed boards by name or FQBN" />
                  </div>
                  {localBoardCatalogLoading ? renderManagerInlineLoading('Loading installed boards...') : null}
                  {localBoardCatalogError ? renderManagerInlineError(localBoardCatalogError) : null}
                  {!localBoardCatalogLoading && !localBoardCatalogError && visibleLocalBoardCatalog.length === 0 ? (
                    <div className="manager-inline-status">No installed board matches found.</div>
                  ) : null}
                  {visibleLocalBoardCatalog.length > 0 ? (
                    <div className="local-board-catalog-list">
                      {visibleLocalBoardCatalog.map((option) => (
                        <button
                          key={option.value}
                          className={`local-board-catalog-item ${row.fqbn === option.value ? 'active' : ''}`}
                          type="button"
                          onClick={() => chooseInstalledBoard(option)}
                        >
                          <strong>{option.label}</strong>
                          <span>{option.value}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <label>
                Port
                {fullPortOptions.length > 0 ? (
                  <select value={row.port} onChange={(event) => updateLocalBoardEdit(row.key, { port: event.target.value })}>
                    <option value="">Select port</option>
                    {fullPortOptions.map((port) => (
                      <option key={port.path} value={port.path}>
                        {localBoardPortLabel(port)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={row.port} onChange={(event) => updateLocalBoardEdit(row.key, { port: event.target.value })} placeholder="COM3 or /dev/ttyUSB0" />
                )}
              </label>
            </div>

            <div className="local-board-actions">
              {row.profileId ? (
                <button className="secondary-button compact" type="button" onClick={() => setSelectedLocalBoardId(row.profileId ?? '')} disabled={isSelected}>
                  {isSelected ? 'Selected' : 'Select'}
                </button>
              ) : null}
              <button className="secondary-button compact" type="button" onClick={() => handleResetLocalBoardEdit(row.key)}>
                Reset
              </button>
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => openBoardCodeDestination(localBoardCodeTarget(row))}
                disabled={busyAction === 'view-code'}
              >
                <FileCode2 size={13} />
                View code
              </button>
              {row.profileId ? (
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => void handleSetLocalBoardCodeVisibility(row, row.sourceCodeVisibility === 'public' ? 'private' : 'public')}
                  disabled={busyAction === `code-visibility:${row.key}`}
                  title={row.sourceCodeVisibility === 'public' ? 'Only your account can restore future snapshots after switching to private.' : 'Any signed-in Tantalum account can restore snapshots from this board marker after switching to public.'}
                >
                  {busyAction === `code-visibility:${row.key}` ? <LoaderCircle size={13} className="spin" /> : null}
                  Code {row.sourceCodeVisibility === 'public' ? 'public' : 'private'}
                </button>
              ) : null}
              <button className="primary-button compact" type="button" onClick={() => void handleSaveLocalBoard(row)} disabled={saveBusy || !canUseBoard}>
                {saveBusy ? <LoaderCircle size={13} className="spin" /> : null}
                {row.profileId ? 'Save' : 'Save board'}
              </button>
              {row.profileId && isCloudCapableBoardFqbn(row.fqbn) ? (
                row.cloudBoardId ? (
                  <button className="secondary-button compact" type="button" disabled>
                    <Link2 size={13} />
                    Cloud linked
                  </button>
                ) : likelyCloudBoard ? (
                  <button className="secondary-button compact" type="button" onClick={() => void linkLocalBoardToCloud(row, likelyCloudBoard, { installRuntime: true })} disabled={linkCloudBusy || !canResolveUsbPort}>
                    {linkCloudBusy ? <LoaderCircle size={13} className="spin" /> : <Link2 size={13} />}
                    Link cloud board
                  </button>
                ) : (
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => void handleMakeLocalBoardCloud(row)}
                    disabled={makeCloudBusy || !canEnableTantalumCloud}
                    title={!canEnableTantalumCloud ? 'Connect and save this ESP32/ESP8266 board over USB before enabling Tantalum Cloud.' : undefined}
                  >
                    {makeCloudBusy ? <LoaderCircle size={13} className="spin" /> : <Link2 size={13} />}
                    Enable Tantalum Cloud
                  </button>
                )
              ) : null}
              {row.profileId && row.cloudBoardId ? (
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => void handleInstallTantalumCloudForLocalBoard(row, linkedCloudBoard)}
                  disabled={!canInstallTantalumCloud || installCloudBusy}
                  title={!canInstallTantalumCloud ? 'Connect the linked local board over USB before installing Tantalum Cloud.' : undefined}
                >
                  {installCloudBusy ? <LoaderCircle size={13} className="spin" /> : <HardDriveUpload size={13} />}
                  {row.lastCloudProvisionedAt ? 'Reinstall Tantalum Cloud' : 'Install Tantalum Cloud'}
                </button>
              ) : null}
              {row.profileId && row.cloudBoardId ? (
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => void openUsbWifiProvisioning(row)}
                  disabled={!canResolveUsbPort || !row.lastCloudProvisionedAt || busyAction === 'wifi-usb-provision'}
                  title={!row.lastCloudProvisionedAt ? 'Install Tantalum Cloud before sending WiFi over USB.' : undefined}
                >
                  <Wifi size={13} />
                  WiFi over USB
                </button>
              ) : null}
              <button className="danger-button compact" type="button" onClick={() => void handleDeleteLocalBoard(row)} disabled={deleteBusy}>
              {deleteBusy ? <LoaderCircle size={13} className="spin" /> : null}
              Forget
              </button>
            </div>
          </>
        ) : null}
      </article>
    );
  }

  function renderBoardsWorkspace() {
    const portOptionMap = new Map<string, LocalBoardPort>();
    const addPortOption = (port: LocalBoardPort | null) => {
      if (port?.path && !portOptionMap.has(port.path)) {
        portOptionMap.set(port.path, port);
      }
    };
    localBoardPorts.forEach(addPortOption);
    detectedLocalBoards.forEach((board) => addPortOption(portOptionFromBoard(board)));
    localBoardProfiles.forEach((board) => addPortOption(portOptionFromBoard(board)));
    const portOptions = Array.from(portOptionMap.values()).sort(compareLocalBoardPorts);

    return (
      <section className="tool-workspace manager-workspace board-manager-workspace local-board-workspace">
        <div className="manager-page-header">
          <div className="manager-title-block">
            <h2>Local boards</h2>
          </div>
          <div className="panel-actions">
            <button className="secondary-button compact" type="button" onClick={handleAddManualLocalBoard}>
              <Plus size={14} />
              Add board
            </button>
            <button className="primary-button compact" type="button" onClick={() => void handleAutoScanLocalBoard()} disabled={localBoardAutoScanLoading || isLocalUploadBusyAction(busyAction)}>
              {localBoardAutoScanLoading ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}
              {localBoardAutoScanLoading ? 'Scanning...' : 'Auto detect'}
            </button>
          </div>
        </div>
        <div className="panel-content manager-panel-content local-board-list">
          {localBoardsError ? renderManagerInlineError(localBoardsError) : null}
          {localBoardRows.length > 0 ? (
            localBoardRows.map((row) => renderLocalBoardCard(row, portOptions))
          ) : (
            <div className="empty-panel">
              <Cpu size={24} />
              <p>No local boards configured. Add a board manually or run Auto detect.</p>
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderRemoteBoardsPanel() {
    return (
      <div className="remote-board-panel">
        <div className="remote-board-panel-header">
          <div>
            <h2>Remote boards</h2>
            <span>{boards.length} saved</span>
          </div>
          <button
            className="primary-button compact"
            type="button"
            disabled
            title="Connect and save a local ESP32/ESP8266 board, then choose Enable Tantalum Cloud."
          >
            <Plus size={14} />
            Use local board
          </button>
        </div>
        <div className="remote-board-list">
          <div className="remote-board-hint">
            Connect and save a local ESP32/ESP8266 board, then choose Enable Tantalum Cloud.
          </div>
          {boardsLoading ? renderManagerInlineLoading('Loading remote boards...') : null}
          {boardsError ? renderManagerInlineError(boardsError) : null}
          {!boardsLoading && boards.length === 0 ? (
            <div className="remote-board-empty">
              <HardDriveUpload size={22} />
              <span>No remote boards yet.</span>
            </div>
          ) : null}
          {boards.map((board) => {
            const status = calculateBoardStatus(board.lastSeen, board.status);
            const isSelected = selectedBoardId === board.$id;
            const selectedLocalCanLink = Boolean(selectedLocalBoard?.profileId && isCloudCapableBoardFqbn(selectedLocalBoard.fqbn));
            const selectedLocalLinkedToThis = selectedLocalBoard?.cloudBoardId === board.$id;
            const selectedLocalLinkBusy = selectedLocalBoard
              ? busyAction === `link-cloud-board:${selectedLocalBoard.key}` || busyAction === `install-cloud-runtime:${selectedLocalBoard.key}`
              : false;
            const linkedLocalRow = localBoardRows.find((row) => row.profileId && row.cloudBoardId === board.$id) ?? null;
            const needsRuntimeInstall = status === 'pending' || !board.lastSeen || !board.runtimeVersion;
            const canOpenRemoteWifiSetup = status === 'online';
            const canInstallFromLinkedLocal = Boolean(linkedLocalRow?.profile && (linkedLocalRow.port || linkedLocalRow.fingerprint));
            const linkedLocalInstallBusy = linkedLocalRow ? busyAction === `install-cloud-runtime:${linkedLocalRow.key}` : false;
            return (
              <div key={board.$id} className={`remote-board-row ${isSelected ? 'active' : ''}`}>
                <button className={`remote-board-item ${isSelected ? 'active' : ''}`} type="button" onClick={() => setSelectedBoardId(board.$id)}>
                  <div>
                    <strong>{board.name}</strong>
                    <span>{board.boardType}</span>
                  </div>
                  <span className={`status-pill status-${status}`}>{status}</span>
                </button>
                {isSelected ? (
                  <div className="remote-board-actions">
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => {
                        const profileId = selectedLocalBoard?.profileId;
                        if (profileId) {
                          setPendingSelectedLocalCloudLink({ profileId, boardId: board.$id });
                        }
                      }}
                      disabled={!selectedLocalCanLink || selectedLocalLinkedToThis || selectedLocalLinkBusy}
                    >
                      {selectedLocalLinkBusy ? <LoaderCircle size={13} className="spin" /> : <Link2 size={13} />}
                      {selectedLocalLinkedToThis ? 'Local linked' : 'Link selected local'}
                    </button>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => {
                        setSelectedBoardId(board.$id);
                        openBoardCodeDestination(remoteBoardCodeTarget(board, linkedLocalRow));
                      }}
                      disabled={busyAction === 'view-code'}
                    >
                      <FileCode2 size={13} />
                      View code
                    </button>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => {
                        setSelectedBoardId(board.$id);
                        if (linkedLocalRow?.profileId) {
                          setPendingCloudRuntimeInstall({ profileId: linkedLocalRow.profileId, boardId: board.$id });
                        }
                      }}
                      disabled={!hasDeviceGatewayFunction() || !canInstallFromLinkedLocal || linkedLocalInstallBusy}
                      title={!canInstallFromLinkedLocal ? 'Link the matching local board before installing Tantalum Cloud.' : undefined}
                    >
                      {linkedLocalInstallBusy ? 'Installing...' : 'Install Tantalum Cloud'}
                    </button>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => {
                        setSelectedBoardId(board.$id);
                        void handleRequestBoardProvisioning(board);
                      }}
                      disabled={busyAction === 'start-provisioning' || !hasBoardAdminFunction() || !canOpenRemoteWifiSetup}
                    >
                      Open WiFi setup
                    </button>
                  </div>
                ) : null}
                {isSelected && !hasDeviceGatewayFunction() ? (
                  <div className="remote-board-hint">Device gateway is missing; Tantalum Cloud install cannot be started.</div>
                ) : null}
                {isSelected && !selectedLocalCanLink ? (
                  <div className="remote-board-hint">Select or save a local ESP32/ESP8266 board to link it here.</div>
                ) : null}
                {isSelected && needsRuntimeInstall ? (
                  <div className="remote-board-hint">Tantalum Cloud install needed. Connect the matching local board, link it, then install Tantalum Cloud over USB.</div>
                ) : null}
                {isSelected && linkedLocalRow && !canInstallFromLinkedLocal ? (
                  <div className="remote-board-hint">Linked local board is not connected over USB. Connect it; the IDE will refresh the live port before installing Tantalum Cloud.</div>
                ) : null}
                {isSelected && !canOpenRemoteWifiSetup ? (
                  <div className="remote-board-hint">Board is not online. Send WiFi directly over USB, or use BLE/SoftAP provisioning from mobile.</div>
                ) : null}
                </div>
            );
          })}
        </div>
      </div>
    );
  }

  /* eslint-disable react-hooks/refs */
  function renderLibraryVersionSelect(library: LibraryEntry, ariaLabel: string) {
    const versionOptions = getLibraryDropdownVersionOptions(library);
    const libraryKey = normalizePackageKey(library.name);
    const isBusy = Boolean(activeLibraryInstalls[libraryKey]) || busyAction === `remove-library:${libraryKey}`;

    return (
      <select
        className="library-version-select"
        value={getSelectedLibraryVersion(library)}
        onChange={(event) => handleLibraryVersionChange(library, event.target.value)}
        onFocus={() => void ensureLibraryMetadata(library)}
        onMouseDown={() => void ensureLibraryMetadata(library)}
        disabled={isBusy}
        aria-label={ariaLabel}
      >
        {versionOptions.map((version) => (
          <option key={version} value={version}>
            {getLibraryVersionOptionLabel(library, version)}
          </option>
        ))}
      </select>
    );
  }

  function renderLibraryInstallButton(library: LibraryEntry, mode: 'install' | 'update' = 'install') {
    const { libraryKey, isInstalling, isRemoving, latestVersion } = getLibraryInstallState(library);
    const isUpdate = mode === 'update';
    const targetVersion = isUpdate ? latestVersion : undefined;
    const installId = activeLibraryInstalls[libraryKey];
    const isStopping = Boolean(installId && stoppingInstallIds[installId]);

    if (isInstalling) {
      return (
        <button
          className="danger-button compact manager-result-action"
          type="button"
          disabled={isStopping}
          onClick={() => handleCancelLibraryInstall(library)}
        >
          {isStopping ? <LoaderCircle size={13} className="spin" /> : <CircleStop size={13} />}
          {isStopping ? 'Stopping' : 'Stop'}
        </button>
      );
    }

    return (
      <button
        className="primary-button compact manager-result-action"
        type="button"
        disabled={isRemoving}
        onClick={() => void handleInstallLibrary(library, targetVersion)}
      >
        {isUpdate ? 'Update' : 'Install'}
      </button>
    );
  }

  function renderLibraryRemoveButton(library: LibraryEntry) {
    const { isInstalling, isRemoving } = getLibraryInstallState(library);

    return (
      <button
        className="danger-button compact manager-result-action"
        type="button"
        disabled={isInstalling || isRemoving}
        onClick={() => void handleRemoveLibrary(library)}
      >
        {isRemoving ? <LoaderCircle size={13} className="spin" /> : null}
        {isRemoving ? 'Removing' : 'Remove'}
      </button>
    );
  }

  function renderLibraryCardActionButton(library: LibraryEntry) {
    const { isOutdated } = getLibraryInstallState(library);

    if (!library.installed) {
      return renderLibraryInstallButton(library);
    }

    if (isOutdated) {
      return renderLibraryInstallButton(library, 'update');
    }

    return renderLibraryRemoveButton(library);
  }

  function renderLibraryDetailActionButtons(library: LibraryEntry) {
    const { isOutdated } = getLibraryInstallState(library);

    if (!library.installed) {
      return renderLibraryInstallButton(library);
    }

    if (isOutdated) {
      return (
        <>
          {renderLibraryInstallButton(library, 'update')}
          {renderLibraryRemoveButton(library)}
        </>
      );
    }

    return renderLibraryRemoveButton(library);
  }

  function renderLibraryResultCard(library: LibraryEntry) {
    const libraryKey = normalizePackageKey(library.name);
    const isSelected = selectedLibraryKey === libraryKey;
    const libraryProvider = library.author || library.maintainer;

    return (
      <article
        key={library.name}
        className={`result-card manager-result-card library-result-card ${isSelected ? 'active' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        onClick={() => handleSelectLibrary(library)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSelectLibrary(library);
          }
        }}
      >
        <div className="manager-result-copy">
          <div className="manager-result-title-row">
            <strong>{library.name}</strong>
            {libraryProvider ? <span className="manager-result-provider">by {libraryProvider}</span> : null}
            {library.installed ? <span className="release-badge">{library.installedVersion ? `Installed ${library.installedVersion}` : 'Installed'}</span> : null}
          </div>
          <p>{library.sentence || library.paragraph || 'Arduino library package'}</p>
          <div className="manager-result-meta">
            <span>{library.version && library.version !== 'latest' ? `Latest ${library.version}` : library.version || 'latest'}</span>
            {library.category ? <span>{library.category}</span> : null}
          </div>
        </div>
        <div
          className="manager-result-controls"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {renderLibraryVersionSelect(library, `Version for ${library.name}`)}
          {renderLibraryCardActionButton(library)}
        </div>
      </article>
    );
  }

  function renderPlatformVersionSelect(platform: BoardPlatform, ariaLabel: string) {
    const versionOptions = getPlatformDropdownVersionOptions(platform);
    const isBusy = busyAction === `platform:${platform.id}` || busyAction === `remove-platform:${platform.id}`;

    return (
      <select
        className="platform-version-select"
        value={getSelectedPlatformVersion(platform)}
        onChange={(event) => handlePlatformVersionChange(platform, event.target.value)}
        disabled={isBusy}
        aria-label={ariaLabel}
      >
        {versionOptions.map((version) => (
          <option key={version} value={version}>
            {getPlatformVersionOptionLabel(platform, version)}
          </option>
        ))}
      </select>
    );
  }

  function renderPlatformInstallButton(platform: BoardPlatform, mode: 'install' | 'update' = 'install') {
    const isInstalling = busyAction === `platform:${platform.id}`;
    const isRemoving = busyAction === `remove-platform:${platform.id}`;
    const isUpdate = mode === 'update';
    const targetVersion = isUpdate ? getPlatformLatestVersion(platform) : undefined;
    const activeInstallId = activePlatformInstalls[platform.id];
    const isStopping = Boolean(activeInstallId && stoppingInstallIds[activeInstallId]);

    if (isInstalling) {
      return (
        <button
          className="danger-button compact manager-result-action"
          type="button"
          onClick={() => {
            if (activeInstallId) {
              void handleCancelPlatformInstallById(activeInstallId, platform.name);
            }
          }}
          disabled={isStopping}
        >
          {isStopping ? <LoaderCircle size={13} className="spin" /> : <CircleStop size={13} />}
          {isStopping ? 'Stopping' : 'Stop'}
        </button>
      );
    }

    return (
      <button
        className="primary-button compact manager-result-action"
        type="button"
        onClick={() => void handleInstallPlatform(platform, targetVersion)}
        disabled={isRemoving}
      >
        {isUpdate ? 'Update' : 'Install'}
      </button>
    );
  }

  function renderPlatformRemoveButton(platform: BoardPlatform) {
    const isInstalling = busyAction === `platform:${platform.id}`;
    const isRemoving = busyAction === `remove-platform:${platform.id}`;

    return (
      <button
        className="danger-button compact manager-result-action"
        type="button"
        onClick={() => void handleRemovePlatform(platform)}
        disabled={isInstalling || isRemoving}
      >
        {isRemoving ? <LoaderCircle size={13} className="spin" /> : null}
        {isRemoving ? 'Removing' : 'Remove'}
      </button>
    );
  }

  function renderPlatformCardActionButton(platform: BoardPlatform) {
    if (!platform.installed) {
      return renderPlatformInstallButton(platform);
    }

    if (isPlatformOutdated(platform)) {
      return renderPlatformInstallButton(platform, 'update');
    }

    return renderPlatformRemoveButton(platform);
  }

  function renderPlatformDetailActionButtons(platform: BoardPlatform) {
    if (!platform.installed) {
      return renderPlatformInstallButton(platform);
    }

    if (isPlatformOutdated(platform)) {
      return (
        <>
          {renderPlatformInstallButton(platform, 'update')}
          {renderPlatformRemoveButton(platform)}
        </>
      );
    }

    return renderPlatformRemoveButton(platform);
  }

  function renderPlatformResultCard(platform: BoardPlatform) {
    const platformKey = normalizePackageKey(platform.id);
    const isSelected = selectedPlatformKey === platformKey;
    const installedVersion = platform.installedVersion || platform.version;
    const platformProvider = platform.maintainer;
    const latestLabel = platform.latest && platform.latest !== 'Unknown'
      ? `Latest ${platform.latest}`
      : platform.version
        ? `Version ${platform.version}`
        : 'latest';

    return (
      <article
        key={platform.id}
        className={`result-card manager-result-card platform-result-card ${isSelected ? 'active' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        onClick={() => handleSelectPlatform(platform)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSelectPlatform(platform);
          }
        }}
      >
        <div className="manager-result-copy">
          <div className="manager-result-title-row">
            <strong>{platform.name}</strong>
            {platformProvider ? <span className="manager-result-provider">by {platformProvider}</span> : null}
            {platform.installed ? <span className="release-badge">{installedVersion ? `Installed ${installedVersion}` : 'Installed'}</span> : null}
          </div>
          <p>{platform.description || 'Board platform package'}</p>
          <div className="manager-result-meta">
            <span>{latestLabel}</span>
            <span>{platform.id}</span>
          </div>
        </div>
        <div
          className="manager-result-controls"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {renderPlatformVersionSelect(platform, `Version for ${platform.name}`)}
          {renderPlatformCardActionButton(platform)}
        </div>
      </article>
    );
  }

  function renderLibraryFilterTabs() {
    return (
      <div className="manager-filter-tabs" role="tablist" aria-label="Library filter">
        <button
          className={libraryManagerTab === 'all' ? 'active' : ''}
          type="button"
          role="tab"
          aria-selected={libraryManagerTab === 'all'}
          onClick={() => setLibraryManagerTab('all')}
        >
          All
        </button>
        <button
          className={libraryManagerTab === 'installed' ? 'active' : ''}
          type="button"
          role="tab"
          aria-selected={libraryManagerTab === 'installed'}
          onClick={() => setLibraryManagerTab('installed')}
        >
          Installed
          <span>{installedLibraries.length}</span>
        </button>
      </div>
    );
  }

  function renderLibraryDetailField(label: string, value: ReactNode) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    return (
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    );
  }

  function renderLibraryDetailTabButton(tab: LibraryDetailTab, label: string, count?: number) {
    return (
      <button
        className={libraryDetailTab === tab ? 'active' : ''}
        type="button"
        role="tab"
        aria-selected={libraryDetailTab === tab}
        onClick={() => setLibraryDetailTab(tab)}
      >
        {label}
        {typeof count === 'number' && count > 0 ? <span>{count}</span> : null}
      </button>
    );
  }

  function renderDetailBulletList(items: string[]) {
    if (items.length === 0) {
      return <span className="library-detail-muted">No metadata available.</span>;
    }

    return (
      <ul className="library-detail-bullet-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }

  function renderLibraryOverviewTab(library: LibraryEntry) {
    const architectures = getLibraryArchitectures(library);

    return (
      <>
        <section className="library-detail-section">
          <h4>Details</h4>
          <dl className="library-detail-grid">
            {renderLibraryDetailField('Author', library.author)}
            {renderLibraryDetailField('Maintainer', library.maintainer)}
            {renderLibraryDetailField('Installed version', library.installedVersion)}
            {renderLibraryDetailField('Latest version', library.version && library.version !== 'latest' ? library.version : undefined)}
            {renderLibraryDetailField('Category', library.category)}
            {renderLibraryDetailField('Architectures', architectures)}
            {renderLibraryDetailField('Types', library.types?.join(', '))}
            {renderLibraryDetailField('License', library.license)}
          </dl>
        </section>

        <section className="library-detail-section">
          <h4>Features</h4>
          {renderDetailBulletList(getLibraryFeatureHighlights(library))}
        </section>

        <section className="library-detail-section">
          <h4>Use cases</h4>
          {renderDetailBulletList(getLibraryUseCases(library))}
        </section>

        <section className="library-detail-section">
          <h4>Resources</h4>
          {library.website ? (
            <button className="secondary-button compact library-detail-resource-button" type="button" onClick={() => void handleOpenLibraryInfo(library)}>
              <ExternalLink size={13} />
              {isGithubLibraryUrl(library.website) ? 'Repository' : 'Official page'}
            </button>
          ) : (
            <span className="library-detail-muted">No external page available.</span>
          )}
        </section>
      </>
    );
  }

  function renderLibraryVersionsTab(library: LibraryEntry) {
    const releases = getLibraryReleases(library);

    return (
      <>
        <section className="library-detail-section">
          <h4>Changelog</h4>
          <span className="library-detail-muted">
            Arduino Library Manager does not provide changelog text for this library. Use the official page or repository for full release notes.
          </span>
          {library.website ? (
            <button className="secondary-button compact library-detail-resource-button" type="button" onClick={() => void handleOpenLibraryInfo(library)}>
              <ExternalLink size={13} />
              Open release notes source
            </button>
          ) : null}
        </section>

        <section className="library-detail-section">
          <h4>Versions</h4>
          {releases.length > 0 ? (
            <ul className="library-release-list">
              {releases.map((release, index) => {
                const isLatest = release.version === library.version || (index === 0 && !library.version);
                const isInstalled = library.installedVersion === release.version;
                const dependencyCount = release.dependencies?.length ?? 0;

                return (
                  <li key={release.version}>
                    <div className="library-release-copy">
                      <div>
                        <strong>{release.version}</strong>
                        {isLatest ? <span className="release-badge">Latest</span> : null}
                        {isInstalled ? <span className="release-badge">Installed</span> : null}
                      </div>
                      <span>
                        {release.archiveFileName || 'Library Manager release'}
                        {typeof release.downloadSize === 'number' ? ` - ${formatBytes(release.downloadSize)}` : ''}
                        {dependencyCount > 0 ? ` - ${dependencyCount} ${dependencyCount === 1 ? 'dependency' : 'dependencies'}` : ''}
                      </span>
                    </div>
                    <button className="secondary-button compact" type="button" onClick={() => handleLibraryVersionChange(library, release.version)}>
                      Select
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <span className="library-detail-muted">No version history metadata available.</span>
          )}
        </section>
      </>
    );
  }

  function renderLibraryExamplesTab(library: LibraryEntry) {
    const examples = library.examples ?? [];

    return (
      <section className="library-detail-section">
        <h4>Examples</h4>
        {!library.installed ? <span className="library-detail-muted">Install this library to inspect bundled examples.</span> : null}
        {library.installed && examples.length === 0 ? <span className="library-detail-muted">No bundled examples found in this installed library.</span> : null}
        {examples.length > 0 ? (
          <ul className="library-example-list">
            {examples.map((example) => (
              <li key={example.relativePath || example.name}>
                <BookOpen size={14} />
                <div>
                  <strong>{example.name}</strong>
                  {example.relativePath ? <span>{example.relativePath}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  function renderLibraryDependenciesTab(library: LibraryEntry) {
    const archiveFileName = getLibraryArchiveFileName(library);
    const downloadSize = getLibraryDownloadSize(library);
    const dependencyLabels = (library.dependencies ?? []).map(getLibraryDependencyLabel).filter(Boolean);

    return (
      <>
        <section className="library-detail-section">
          <h4>Dependencies</h4>
          {dependencyLabels.length > 0 ? (
            <ul className="library-detail-list">
              {dependencyLabels.map((dependency) => (
                <li key={dependency}>{dependency}</li>
              ))}
            </ul>
          ) : (
            <span className="library-detail-muted">No dependency metadata available.</span>
          )}
        </section>

        {(archiveFileName || downloadSize || library.installDir) ? (
          <section className="library-detail-section">
            <h4>Package</h4>
            <dl className="library-detail-grid">
              {renderLibraryDetailField('Archive', archiveFileName)}
              {renderLibraryDetailField('Download size', typeof downloadSize === 'number' ? formatBytes(downloadSize) : undefined)}
              {renderLibraryDetailField('Install folder', library.installDir)}
            </dl>
          </section>
        ) : null}
      </>
    );
  }

  function renderLibraryDetailTabContent(library: LibraryEntry) {
    if (libraryDetailTab === 'versions') {
      return renderLibraryVersionsTab(library);
    }

    if (libraryDetailTab === 'examples') {
      return renderLibraryExamplesTab(library);
    }

    if (libraryDetailTab === 'dependencies') {
      return renderLibraryDependenciesTab(library);
    }

    return renderLibraryOverviewTab(library);
  }

  function renderLibraryDetailsPanel(library: LibraryEntry | null) {
    if (!library) {
      return (
        <section className="library-manager-detail-pane library-manager-detail-empty">
          <Library size={28} />
          <strong>Select a library to view info.</strong>
        </section>
      );
    }

    const paragraph = library.paragraph && library.paragraph !== library.sentence ? library.paragraph : '';
    const versionCount = getLibraryReleases(library).length;
    const exampleCount = library.examples?.length ?? 0;
    const dependencyCount = library.dependencies?.length ?? 0;

    return (
      <section className="library-manager-detail-pane" aria-label={`${library.name} details`}>
        <div className="library-detail-header">
          <div>
            <h3>{library.name}</h3>
            <div className="library-detail-badges">
              {library.installed ? <span className="release-badge">{library.installedVersion ? `Installed ${library.installedVersion}` : 'Installed'}</span> : null}
              {library.version && library.version !== 'latest' ? <span>Latest {library.version}</span> : null}
              {library.category ? <span>{library.category}</span> : null}
            </div>
          </div>
        </div>

        <div className="library-detail-summary">
          <p>{library.sentence || library.paragraph || 'Arduino library package'}</p>
          {paragraph ? <p>{paragraph}</p> : null}
        </div>

        <div className="library-detail-controls">
          {renderLibraryVersionSelect(library, `Detail version for ${library.name}`)}
          {renderLibraryDetailActionButtons(library)}
          <button className="secondary-button compact manager-result-action" type="button" onClick={() => void handleOpenLibraryInfo(library)}>
            <ExternalLink size={13} />
            More info
          </button>
        </div>

        <div className="library-detail-tabs" role="tablist" aria-label={`${library.name} details sections`}>
          {renderLibraryDetailTabButton('overview', 'Overview')}
          {renderLibraryDetailTabButton('versions', 'Versions', versionCount)}
          {renderLibraryDetailTabButton('examples', 'Examples', exampleCount)}
          {renderLibraryDetailTabButton('dependencies', 'Dependencies', dependencyCount)}
        </div>

        <div className="library-detail-tab-panel" role="tabpanel">
          {renderLibraryDetailTabContent(library)}
        </div>
      </section>
    );
  }

  function renderPlatformDetailTabButton(tab: PlatformDetailTab, label: string, count?: number) {
    return (
      <button
        className={platformDetailTab === tab ? 'active' : ''}
        type="button"
        role="tab"
        aria-selected={platformDetailTab === tab}
        onClick={() => setPlatformDetailTab(tab)}
      >
        {label}
        {typeof count === 'number' && count > 0 ? <span>{count}</span> : null}
      </button>
    );
  }

  function renderPlatformOverviewTab(platform: BoardPlatform) {
    return (
      <>
        <section className="library-detail-section">
          <h4>Details</h4>
          <dl className="library-detail-grid">
            {renderLibraryDetailField('Package ID', platform.id)}
            {renderLibraryDetailField('Maintainer', platform.maintainer)}
            {renderLibraryDetailField('Installed version', platform.installedVersion || (platform.installed ? platform.version : undefined))}
            {renderLibraryDetailField('Latest version', platform.latest && platform.latest !== 'Unknown' ? platform.latest : undefined)}
            {renderLibraryDetailField('Website', platform.website ? platform.website.replace(/^https?:\/\//, '') : undefined)}
          </dl>
        </section>

        <section className="library-detail-section">
          <h4>Supported boards</h4>
          {renderDetailBulletList(getPlatformSupportedBoards(platform))}
        </section>

        <section className="library-detail-section">
          <h4>Use cases</h4>
          {renderDetailBulletList(getPlatformUseCases(platform))}
        </section>

        <section className="library-detail-section">
          <h4>Resources</h4>
          {platform.website ? (
            <button className="secondary-button compact library-detail-resource-button" type="button" onClick={() => void handleOpenPlatformInfo(platform)}>
              <ExternalLink size={13} />
              Official page
            </button>
          ) : (
            <span className="library-detail-muted">No external page available.</span>
          )}
        </section>
      </>
    );
  }

  function renderPlatformVersionsTab(platform: BoardPlatform) {
    const selectedVersion = getSelectedPlatformVersion(platform);
    const versions = getPlatformVersionOptions(platform).filter((version) => version !== 'latest');

    return (
      <section className="library-detail-section">
        <h4>Versions</h4>
        {versions.length > 0 ? (
          <ul className="library-release-list">
            {versions.map((version) => {
              const isLatest = version === platform.latest;
              const isInstalled = version === platform.installedVersion || (platform.installed && version === platform.version);
              const isSelected = version === selectedVersion;

              return (
                <li key={version}>
                  <div className="library-release-copy">
                    <div>
                      <strong>{version}</strong>
                      {isLatest ? <span className="release-badge">Latest</span> : null}
                      {isInstalled ? <span className="release-badge">Installed</span> : null}
                    </div>
                    <span>{platform.id}</span>
                  </div>
                  <button className="secondary-button compact" type="button" onClick={() => handlePlatformVersionChange(platform, version)} disabled={isSelected}>
                    {isSelected ? 'Selected' : 'Select'}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="library-detail-muted">No version history metadata available.</span>
        )}
      </section>
    );
  }

  function renderPlatformDetailTabContent(platform: BoardPlatform) {
    if (platformDetailTab === 'versions') {
      return renderPlatformVersionsTab(platform);
    }

    return renderPlatformOverviewTab(platform);
  }

  function renderPlatformDetailsPanel(platform: BoardPlatform | null) {
    if (!platform) {
      return (
        <section className="platform-manager-detail-pane library-manager-detail-empty">
          <BookOpen size={28} />
          <strong>Select a board core to view info.</strong>
        </section>
      );
    }

    const installedVersion = platform.installedVersion || (platform.installed ? platform.version : undefined);
    const versionCount = getPlatformVersionOptions(platform).filter((version) => version !== 'latest').length;

    return (
      <section className="platform-manager-detail-pane" aria-label={`${platform.name} details`}>
        <div className="library-detail-header">
          <div>
            <h3>{platform.name}</h3>
            <div className="library-detail-badges">
              {platform.installed ? <span className="release-badge">{installedVersion ? `Installed ${installedVersion}` : 'Installed'}</span> : null}
              {platform.latest && platform.latest !== 'Unknown' ? <span>Latest {platform.latest}</span> : null}
              {platform.maintainer ? <span>{platform.maintainer}</span> : null}
            </div>
          </div>
        </div>

        <div className="library-detail-summary">
          <PlatformDescription description={platform.description || 'Board platform package for Arduino-compatible cores.'} />
        </div>

        <div className="library-detail-controls platform-detail-controls">
          {renderPlatformVersionSelect(platform, `Detail version for ${platform.name}`)}
          {renderPlatformDetailActionButtons(platform)}
          <button className="secondary-button compact manager-result-action" type="button" onClick={() => void handleOpenPlatformInfo(platform)}>
            <ExternalLink size={13} />
            More info
          </button>
        </div>

        <div className="library-detail-tabs" role="tablist" aria-label={`${platform.name} details sections`}>
          {renderPlatformDetailTabButton('overview', 'Overview')}
          {renderPlatformDetailTabButton('versions', 'Versions', versionCount)}
        </div>

        <div className="library-detail-tab-panel" role="tabpanel">
          {renderPlatformDetailTabContent(platform)}
        </div>
      </section>
    );
  }

  function renderLibrariesWorkspace() {
    const hasLibraries = visibleLibraryResults.length > 0;
    const loadingMessage = librarySearchTerm ? 'Searching libraries...' : 'Loading libraries...';
    const emptyLibraryMessage = libraryManagerTab === 'installed'
      ? librarySearchTerm
        ? 'No installed libraries match your search.'
        : 'No installed libraries yet.'
      : librarySearchTerm
        ? 'No libraries found. Try a different search.'
        : 'No uninstalled featured libraries to show.';

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
        {renderLibraryFilterTabs()}
        <div className="panel-content manager-panel-content result-list">
          {librariesLoading && !hasLibraries ? renderManagerLoading(loadingMessage) : null}
          {!librariesLoading && librariesError && !hasLibraries ? renderManagerError(librariesError) : null}
          {!librariesLoading && !librariesError && !hasLibraries ? (
            <div className="manager-state manager-state-empty">
              <Library size={22} />
              <span>{emptyLibraryMessage}</span>
            </div>
          ) : null}
          {hasLibraries ? (
            <>
              {librariesLoading ? renderManagerInlineLoading(loadingMessage) : null}
              {librariesError ? renderManagerInlineError(librariesError) : null}
              {visibleLibraryResults.map((library) => renderLibraryResultCard(library))}
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
              {visiblePlatformResults.map((platform) => renderPlatformResultCard(platform))}
            </>
          ) : null}
        </div>
      </section>
    );
  }
  /* eslint-enable react-hooks/refs */

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
              Open Project
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
              renderIcon={renderWorkspaceFileTreeIcon}
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
          <nav className="left-nav" aria-label="Project navigation">
            <div className="left-nav-primary-row">
              <button className="left-nav-new-sketch-button" type="button" onClick={() => void createNewProject()}>
                <Plus size={16} />
                New Project
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
                Project
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
                  renderIcon={renderWorkspaceFileTreeIcon}
                  contextMenu={{ renderMenu: renderWorkspaceFileTreeContextMenu }}
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
                          id: 'refresh-explorer',
                          label: 'Refresh explorer',
                          icon: <RefreshCcw aria-hidden="true" size={13} strokeWidth={1.85} />,
                          onSelect: refreshFileTree,
                        },
                        ...headerProps.actions.filter((action) => action.id !== 'new-file' && action.id !== 'new-folder').map(renderFileTreeHeaderMoreAction),
                      ]),
                      [
                        {
                          id: 'open-workspace',
                          label: 'Open Project',
                          icon: <FolderOpen aria-hidden="true" size={14} strokeWidth={1.85} />,
                          onSelect: () => void openFolderPicker(),
                        },
                      ],
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
                  <button className="icon-button" type="button" disabled title="Connect and save a local ESP32/ESP8266 board, then choose Enable Tantalum Cloud.">
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
                    <p>No boards yet. Connect and save a local ESP32/ESP8266 board, then choose Enable Tantalum Cloud.</p>
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
              {renderLibraryFilterTabs()}
              <div className="panel-content result-list" aria-busy={librariesLoading} title={librariesError ?? undefined}>
                {visibleLibraryResults.map((library) => renderLibraryResultCard(library))}
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
                {visiblePlatformResults.map((platform) => renderPlatformResultCard(platform))}
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
                <button className="icon-button" type="button" disabled title="Connect and save a local ESP32/ESP8266 board, then choose Enable Tantalum Cloud.">
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
                  <p>No boards yet. Connect and save a local ESP32/ESP8266 board, then choose Enable Tantalum Cloud.</p>
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
            {renderLibraryFilterTabs()}
            <div className="panel-content result-list">
              {visibleLibraryResults.map((library) => renderLibraryResultCard(library))}
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
              {visiblePlatformResults.map((platform) => renderPlatformResultCard(platform))}
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
          <div className="editor-board-toolbar">
            <div className="editor-board-selector">
              <Cpu size={15} />
              <select value={editorBoardSelectionValue} onChange={(event) => handleEditorBoardSelectionChange(event.target.value)} title="Selected board">
                <optgroup label="Local boards">
                  {localBoardRows.some((row) => row.profileId) ? (
                    localBoardRows
                      .filter((row) => row.profileId)
                      .map((row) => (
                        <option key={row.profileId} value={editorLocalBoardValue(row.profileId ?? '')}>
                          {`${localBoardDisplayName(row)}${row.port ? ` (${row.port})` : ''}`}
                        </option>
                      ))
                  ) : (
                    <option value="">No local board</option>
                  )}
                </optgroup>
                <optgroup label="Remote boards">
                  {boards.length > 0 ? (
                    boards.map((board) => (
                      <option key={board.$id} value={editorCloudBoardValue(board.$id)}>
                        {`${board.name} (OTA)`}
                      </option>
                    ))
                  ) : (
                    <option value="" disabled>No remote boards</option>
                  )}
                </optgroup>
              </select>
              <span className={`editor-board-status ${editorBoardStatusConnected ? 'connected' : ''}`}>
                {editorBoardStatusText}
              </span>
            </div>
            <div className="editor-board-actions">
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => void handleCompile()}
                disabled={!activeTab || busyAction === 'compile' || editorUploadBusy}
              >
                {busyAction === 'compile' || busyAction === 'verify-before-upload' ? <LoaderCircle size={13} className="spin" /> : <CheckCircle2 size={14} />}
                Verify
              </button>
              <button
                className="primary-button compact"
                type="button"
                onClick={() => void handleUploadEditorBoard()}
                disabled={editorUploadDisabled}
              >
                {editorUploadBusy ? <LoaderCircle size={13} className="spin" /> : selectedEditorCloudBoard ? <Wifi size={14} /> : <HardDriveUpload size={14} />}
                {editorUploadLabel}
              </button>
            </div>
          </div>
          {syncedTabs.length > 0 ? (
            <div ref={editorTabsScrollHostRef} className="editor-tabs-scroll-host" onWheelCapture={handleEditorTabsWheel}>
              <EditorTabs
                tabs={syncedTabs}
                activeTabPath={activeTab?.path ?? null}
                onTabClick={(path) => selectTabByPath(path)}
                onTabClose={(path) => closeTab(path)}
                onTabReorder={handleTabReorder}
              />
            </div>
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
                  extraEditorClassName: 'tantalum-source-editor',
                  find: { addExtraSpaceOnTop: false },
                  fixedOverflowWidgets: true,
                  folding: true,
                  foldingHighlight: true,
                  fontFamily: uiPreferences.editorFontFamily,
                  fontSize: uiPreferences.editorFontSize,
                  formatOnPaste: uiPreferences.editorFormatOnPaste,
                  formatOnType: uiPreferences.editorFormatOnType,
                  guides: { bracketPairs: uiPreferences.editorBracketPairs, indentation: true },
                  hover: { enabled: true, sticky: true, above: false },
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
                  readOnly: Boolean(activeTab.agentPreview),
                  readOnlyMessage: { value: 'Keep or revert Tantalum AI changes before editing this file.' },
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
                {workspacePath ? (
                  <div className="editor-empty-panel editor-empty-workspace-panel">
                    <p>Select a file to edit</p>
                    <button className="secondary-button" type="button" onClick={createNewTab}>
                      <Plus size={16} />
                      <span>New file</span>
                    </button>
                  </div>
                ) : (
                  <div className="editor-empty-actions">
                    <button className="editor-empty-action-tile" type="button" onClick={() => void createNewProject()}>
                      <Plus size={30} />
                      <span>New Project</span>
                    </button>
                    <button className="editor-empty-action-tile" type="button" onClick={() => void openFolderPicker()}>
                      <FolderOpen size={30} />
                      <span>Open Project</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {pendingAgentReview ? (
              <div className="agent-editor-review-bar">
                <div>
                  <span className="release-badge">Tantalum AI live changes</span>
                  <strong>{pendingAgentReview.files.length} applied {pendingAgentReview.files.length === 1 ? 'change' : 'changes'}</strong>
                  {activeAgentChange ? <code>{activeAgentChange.path}</code> : null}
                </div>
                <div className="agent-editor-review-actions">
                  <button className="agent-editor-review-action accept" type="button" disabled={resolvingAgentReview} onClick={() => void resolvePendingAgentReview(true)}>
                    {resolvingAgentReview ? <LoaderCircle size={14} className="spin" /> : null}
                    Keep
                  </button>
                  <button className="agent-editor-review-action decline" type="button" disabled={resolvingAgentReview} onClick={() => void resolvePendingAgentReview(false)}>
                    Revert
                  </button>
                </div>
              </div>
            ) : null}
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

        <aside
          className={`right-panel inspector-panel ${
            sidebar === 'git'
              ? 'git-graph-panel-host'
              : sidebar === 'my-projects'
                ? 'my-projects-panel-host'
                : sidebar === 'libraries'
                ? 'library-detail-panel-host'
                : sidebar === 'platforms'
                  ? 'platform-detail-panel-host'
                    : sidebar === 'boards'
                      ? 'remote-board-panel-host'
                      : 'chat-panel'
          }`}
        >
          <div className="inspector-tabs" style={{ display: 'none' }}></div>
          <div className="inspector-body">
            {sidebar === 'git' ? (
              <GitHistoryPanel controller={gitController} />
            ) : sidebar === 'my-projects' ? (
              myProjectsDetailPanel
            ) : sidebar === 'libraries' ? (
              renderLibraryDetailsPanel(selectedLibrary)
            ) : sidebar === 'platforms' ? (
              renderPlatformDetailsPanel(selectedPlatform)
            ) : sidebar === 'boards' ? (
              renderRemoteBoardsPanel()
            ) : (
              <AgentPanel
                user={user}
                workspacePath={workspacePath}
                activeTab={activeTab && !activeTab.path.startsWith('untitled:') && !activeTab.agentPreview ? { path: activeTab.path, name: activeTab.name, content: editorValue, isDirty: Boolean(activeTab.isDirty) } : null}
                activeSelection={activeEditorSelection}
                boardContext={selectedBoard ? { id: selectedBoard.$id, name: selectedBoard.name, fqbn: selectedBoard.boardType } : null}
                localBoardContext={selectedLocalBoard ? {
                  profileId: selectedLocalBoard.profileId,
                  name: localBoardDisplayName(selectedLocalBoard),
                  fqbn: selectedLocalBoard.fqbn,
                  port: selectedLocalBoard.port,
                  boardLabel: selectedLocalBoard.boardLabel,
                  connected: selectedLocalBoard.connected,
                } : null}
                arduinoPreferences={{
                  verifyBeforeUpload: uiPreferences.verifyBeforeUpload,
                  nextReleaseVersion: releaseVersion,
                }}
                pushConsole={pushConsole}
                pushToast={pushToast}
                pendingReview={pendingAgentReview}
                resolvingReview={resolvingAgentReview}
                reviewResolutionNotice={agentReviewNotice}
                onAgentChangesPrepared={handleAgentChangesPrepared}
                restorePoints={agentRestorePoints}
                onRestoreToMessage={restoreAgentThreadToMessage}
                onPreviewAgentFile={(relativePath) => {
                  const change = pendingAgentReview?.files.find((file) => file.path === relativePath);
                  if (change && pendingAgentReview) {
                    showAgentPreviewFile(change, pendingAgentReview.id);
                  }
                }}
                onOpenContextFile={(filePath) => {
                  void openFile(filePath, { preview: false }).then(() => {
                    window.requestAnimationFrame(() => editorRef.current?.focus());
                  });
                }}
                onResolveAgentChanges={resolvePendingAgentReview}
                defaultView="chat"
                chatOnly={true}
                onOpenSettings={onOpenAgentSettings ?? onOpenSettings}
                onClosePanel={() => onRightPanelOpenChange(false)}
                onSignedOut={onSignedOut}
              />
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
            <button className={consoleView === 'serial' ? 'active' : ''} type="button" onClick={() => openConsolePanel('serial')}>
              Serial Monitor
            </button>
          </div>
          <div className="console-actions">
            {consoleView === 'output' ? (
              <>
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
              </>
            ) : null}
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
        <SerialMonitor
          active={isConsoleVisible && consoleView === 'serial'}
          selectedPort={selectedLocalBoard?.port || null}
          selectedBoardName={selectedLocalBoard ? localBoardDisplayName(selectedLocalBoard) : null}
          uiPreferences={uiPreferences}
        />
      </section>

      <footer className="statusbar">
        <span>{workspacePath ? workspacePath : 'No workspace open'}</span>
        <div className="statusbar-actions">
          {!isConsoleVisible && !isTerminalWorkspaceActive ? (
            <button className="ghost-button compact statusbar-console-toggle" type="button" onClick={() => openConsolePanel(consoleView)} title={`Restore ${consoleViewLabel} panel`}>
              <ChevronUp size={14} />
              Open {consoleViewLabel}
            </button>
          ) : null}
          <span>
            {selectedEditorCloudBoard
              ? `${selectedEditorCloudBoard.name} • OTA ${selectedEditorCloudStatus}`
              : selectedEditorLocalBoard
                ? `${localBoardDisplayName(selectedEditorLocalBoard)} • ${canUploadLocalBoard(selectedEditorLocalBoard) ? selectedEditorLocalBoard.port || selectedEditorLocalBoard.fqbn : 'disconnected'}`
                : 'No board selected'}
          </span>
        </div>
      </footer>

      <Modal open={boardModalOpen} title="Enable Tantalum Cloud from a local board" subtitle="Connect and save a local ESP32/ESP8266 board, then choose Enable Tantalum Cloud from the local board card." onClose={() => setBoardModalOpen(false)}>
        <form className="modal-form" onSubmit={handleCreateBoard}>
          <label>
            Board name
            <input value={boardForm.name} onChange={(event) => setBoardForm((current) => ({ ...current, name: event.target.value }))} placeholder="Living room ESP32" disabled />
          </label>
          <label>
            Board type
            <select value={boardForm.boardType} onChange={(event) => setBoardForm((current) => ({ ...current, boardType: event.target.value }))} disabled>
              {CLOUD_BOARD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={() => setBoardModalOpen(false)}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled>
              Use Local boards
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={usbWifiModalOpen}
        title="WiFi over USB"
        subtitle={usbWifiTargetRow ? `Send WiFi credentials directly to ${localBoardDisplayName(usbWifiTargetRow)}.` : 'Send WiFi credentials directly to the board.'}
        onClose={() => {
          setUsbWifiModalOpen(false);
          setUsbWifiProfileId('');
          setUsbWifiForm({ ssid: '', password: '' });
        }}
      >
        <form className="modal-form" onSubmit={handleProvisionWifiOverUsb}>
          <div className="inline-banner">
            Your WiFi name and password are sent directly over USB, Bluetooth, or SoftAP to the board. They are not uploaded to Tantalum Cloud and are not stored by the IDE.
          </div>
          <label>
            WiFi name
            <input value={usbWifiForm.ssid} onChange={(event) => setUsbWifiForm((current) => ({ ...current, ssid: event.target.value }))} placeholder="Network SSID" autoComplete="off" />
          </label>
          <label>
            WiFi password
            <input value={usbWifiForm.password} onChange={(event) => setUsbWifiForm((current) => ({ ...current, password: event.target.value }))} placeholder="Network password" type="password" autoComplete="off" />
          </label>
          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setUsbWifiModalOpen(false);
                setUsbWifiProfileId('');
                setUsbWifiForm({ ssid: '', password: '' });
              }}
            >
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={busyAction === 'wifi-usb-provision'}>
              {busyAction === 'wifi-usb-provision' ? 'Sending...' : 'Send to board'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={provisionModalOpen}
        title="Install Tantalum Cloud"
        subtitle="This flashes the Tantalum cloud runtime so the board can heartbeat, receive OTA updates, and accept secure WiFi provisioning. WiFi credentials are not uploaded."
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
              {busyAction === 'provision' ? 'Installing...' : 'Install runtime'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={releaseModalOpen} title="Create firmware release" subtitle="Compile the current Project and upload it to Appwrite storage." onClose={() => setReleaseModalOpen(false)}>
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
        open={Boolean(boardCodeSnapshotRequest)}
        title="View board code"
        subtitle={boardCodeSnapshotRequest ? `Exact source snapshots for ${boardCodeSnapshotRequest.target.label}.` : 'Exact source snapshots.'}
        size="md"
        onClose={() => setBoardCodeSnapshotRequest(null)}
      >
        {boardCodeSnapshotRequest ? (
          <div className="modal-form">
            <div className="inline-banner">
              View Code restores only source snapshots saved during Tantalum uploads. Boards flashed outside Tantalum cannot be restored from firmware.
            </div>
            {boardCodeSnapshotRequest.loading ? renderManagerInlineLoading('Checking source snapshots...') : null}
            {boardCodeSnapshotRequest.error ? renderManagerInlineError(boardCodeSnapshotRequest.error) : null}
            {!boardCodeSnapshotRequest.loading && boardCodeSnapshotRequest.result ? (
              boardCodeSnapshotRequest.result.snapshots.length > 0 ? (
                <div className="release-list">
                  {boardCodeSnapshotRequest.result.snapshots.map((snapshot) => (
                    <article key={snapshot.markerId} className="release-item">
                      <div>
                        <strong>{snapshot.status === 'current' ? 'Latest snapshot' : 'Previous snapshot'}</strong>
                        <span>{snapshot.boardName || boardCodeSnapshotRequest.target.label} • {snapshot.boardType || boardCodeSnapshotRequest.target.board.fqbn}</span>
                        <span>{formatBoardCodeSnapshotFlash(snapshot)} • {snapshot.visibility === 'public' ? 'Public' : 'Private'} • {formatBoardCodeSnapshotVerification(snapshot, boardCodeSnapshotRequest.result?.status)}</span>
                        <span>Created {formatBoardCodeSnapshotDate(snapshot.createdAt)}{snapshot.appliedAt ? ` • Applied ${formatBoardCodeSnapshotDate(snapshot.appliedAt)}` : ''}</span>
                      </div>
                      <div className="release-actions">
                        <button
                          className="primary-button compact"
                          type="button"
                          onClick={() => setBoardCodeRestoreRequest({
                            target: boardCodeSnapshotRequest.target,
                            snapshot,
                            markerVerifiedFromFirmware: Boolean(snapshot.markerVerifiedFromFirmware || boardCodeSnapshotRequest.result?.markerVerifiedFromFirmware),
                          })}
                          disabled={busyAction === 'view-code'}
                        >
                          Restore
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-panel compact">
                  <FileCode2 size={20} />
                  <p>{boardCodeSnapshotRequest.result.message || 'No restorable Tantalum source snapshots are available for this board.'}</p>
                </div>
              )
            ) : null}
            {boardCodeSnapshotRequest.result?.warnings?.length ? (
              <div className="inline-banner inline-banner-warning">
                {boardCodeSnapshotRequest.result.warnings.join('\n')}
              </div>
            ) : null}
            <div className="form-actions">
              <button className="secondary-button" type="button" onClick={() => setBoardCodeSnapshotRequest(null)}>
                Close
              </button>
              <button className="secondary-button" type="button" onClick={() => void handleListBoardCodeSnapshots(boardCodeSnapshotRequest.target)} disabled={busyAction === 'view-code'}>
                Refresh
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(boardCodeRestoreRequest)}
        title="Restore source snapshot"
        subtitle={boardCodeRestoreRequest ? `Choose where to restore ${boardCodeRestoreRequest.target.label}.` : 'Choose restore destination.'}
        size="sm"
        onClose={() => setBoardCodeRestoreRequest(null)}
      >
        {boardCodeRestoreRequest ? (
          <div className="modal-form">
            <div className="inline-banner">
              Restoring {boardCodeRestoreRequest.snapshot.status === 'current' ? 'the latest' : 'the previous'} {formatBoardCodeSnapshotFlash(boardCodeRestoreRequest.snapshot)} snapshot.
            </div>
            <div className="form-actions">
              <button className="secondary-button" type="button" onClick={() => setBoardCodeRestoreRequest(null)}>
                Cancel
              </button>
              <button className="secondary-button" type="button" onClick={() => void handleRestoreBoardCodeSnapshotDestination('current')} disabled={!workspacePath || busyAction === 'view-code'}>
                Current workspace
              </button>
              <button className="primary-button" type="button" onClick={() => void handleRestoreBoardCodeSnapshotDestination('new')} disabled={busyAction === 'view-code'}>
                New workspace
              </button>
            </div>
          </div>
        ) : null}
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

      <SerialPortBlockerDialog
        open={Boolean(serialBlockerDialog)}
        port={serialBlockerDialog?.port || ''}
        title={serialBlockerDialog?.title}
        subtitle={serialBlockerDialog?.subtitle}
        retryLabel={serialBlockerDialog?.retryLabel || 'Retry'}
        onClose={() => setSerialBlockerDialog(null)}
        onRetry={serialBlockerDialog?.onRetry}
      />

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <div className="toast-content">
              <span className="toast-message">{toast.message}</span>
              {toast.detail ? <span className="toast-detail">{toast.detail}</span> : null}
              {toast.progress !== undefined ? (
                <>
                  <div className={`toast-progress ${toast.progress === null ? 'toast-progress-indeterminate' : ''}`} aria-hidden="true">
                    <span style={toast.progress === null ? undefined : { width: `${toast.progress}%` }} />
                  </div>
                  {toast.progressLabel ? <span className="toast-progress-label">{toast.progressLabel}</span> : null}
                </>
              ) : null}
            </div>
            {toast.actions?.length ? (
              <div className="toast-actions">
                {toast.actions.map((action) => (
                  <button
                    key={action.label}
                    className="toast-action-button"
                    type="button"
                    onClick={() => {
                      try {
                        action.onSelect();
                      } finally {
                        if (action.dismissOnSelect !== false) {
                          dismissToast(toast.id);
                        }
                      }
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
            <button className="toast-close-button" type="button" onClick={() => dismissToast(toast.id)} aria-label="Close notification">
              <X aria-hidden="true" size={18} strokeWidth={2.2} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
