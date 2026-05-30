import materialIconThemeDefinition from 'material-icon-theme/dist/material-icons.json';

const materialIconSvgModules = import.meta.glob('../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

type MaterialIconDefinition = {
  iconPath?: string;
};

type MaterialIconTheme = {
  iconDefinitions: Record<string, MaterialIconDefinition>;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folder?: string;
  folderExpanded?: string;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  file?: string;
};

const materialIconTheme = materialIconThemeDefinition as MaterialIconTheme;

const materialIconSvgsByFileName = Object.fromEntries(
  Object.entries(materialIconSvgModules).map(([modulePath, svg]) => [modulePath.split(/[\\/]/).pop() ?? '', svg]),
);
const materialIconUrlsByFileName = Object.fromEntries(Object.entries(materialIconSvgsByFileName).map(([fileName, svg]) => [fileName, createSvgDataUrl(svg)]));
const FALLBACK_FILE_ICON_URL = createSvgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#8fa3b8" d="M3 1.5h6.2L13 5.3v9.2H3z"/><path fill="#dbe7f5" d="M9 1.5v4h4z"/></svg>');
const FALLBACK_FOLDER_ICON_URL = createSvgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#d6a64b" d="M1.5 4h5l1.2 1.4H14.5v8.1h-13z"/><path fill="#e8bd63" d="M1.5 5.2h13v8.3h-13z"/></svg>');

const materialFileNameIcons = createCaseInsensitiveMap(materialIconTheme.fileNames);
const materialFileExtensionIcons = createCaseInsensitiveMap(materialIconTheme.fileExtensions);
const materialFolderNameIcons = createCaseInsensitiveMap(materialIconTheme.folderNames);
const materialFolderNameExpandedIcons = createCaseInsensitiveMap(materialIconTheme.folderNamesExpanded);
const materialLanguageFileExtensionIcons = createCaseInsensitiveMap({
  cjs: 'javascript',
  cts: 'typescript',
  html: 'html',
  js: 'javascript',
  mts: 'typescript',
  ts: 'typescript',
});

function createCaseInsensitiveMap(values: Record<string, string> = {}) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
}

function createSvgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\/+/g, '');
}

function getBaseName(filePath: string) {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function getExtensionCandidates(baseName: string) {
  const candidates: string[] = [];
  const parts = baseName.toLowerCase().split('.');

  for (let index = 1; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join('.');
    if (suffix) {
      candidates.push(suffix);
    }
  }

  if (baseName.startsWith('.') && baseName.length > 1) {
    candidates.unshift(baseName.slice(1).toLowerCase());
  }

  return candidates;
}

function getIconFileName(iconId: string) {
  const iconPath = materialIconTheme.iconDefinitions[iconId]?.iconPath;
  return iconPath?.split(/[\\/]/).pop() ?? `${iconId}.svg`;
}

function resolveIconUrl(iconId?: string, fallbackUrl = FALLBACK_FILE_ICON_URL) {
  const iconFileName = resolveIconFileName(iconId);
  return materialIconUrlsByFileName[iconFileName] ?? materialIconUrlsByFileName['file.svg'] ?? fallbackUrl;
}

function resolveIconSvg(iconId?: string) {
  const iconFileName = resolveIconFileName(iconId);
  return materialIconSvgsByFileName[iconFileName] ?? materialIconSvgsByFileName['file.svg'] ?? '';
}

function resolveIconFileName(iconId?: string) {
  const resolvedIconId = iconId ?? materialIconTheme.file ?? 'file';
  return getIconFileName(resolvedIconId);
}

function getMaterialFileIconId(filePath: string) {
  const normalizedPath = normalizePath(filePath).toLowerCase();
  const baseName = getBaseName(filePath).toLowerCase();
  const exactFileIcon = materialFileNameIcons[normalizedPath] ?? materialFileNameIcons[baseName];

  if (exactFileIcon) {
    return exactFileIcon;
  }

  for (const extension of getExtensionCandidates(baseName)) {
    const extensionIcon = materialFileExtensionIcons[extension] ?? materialLanguageFileExtensionIcons[extension];
    if (extensionIcon) {
      return extensionIcon;
    }
  }

  return undefined;
}

function getMaterialFolderIconId(folderPath: string, expanded = false) {
  const normalizedPath = normalizePath(folderPath).toLowerCase();
  const baseName = getBaseName(folderPath).toLowerCase();
  const folderIcons = expanded ? materialFolderNameExpandedIcons : materialFolderNameIcons;
  const folderIcon = folderIcons[normalizedPath] ?? folderIcons[baseName];

  if (folderIcon) {
    return folderIcon;
  }

  return expanded ? materialIconTheme.folderExpanded ?? 'folder-open' : materialIconTheme.folder ?? 'folder';
}

export function getMaterialFileIconUrl(filePath: string) {
  return resolveIconUrl(getMaterialFileIconId(filePath));
}

export function getMaterialFileIconSvg(filePath: string) {
  return resolveIconSvg(getMaterialFileIconId(filePath));
}

export function getMaterialFolderIconUrl(folderPath: string, expanded = false) {
  return resolveIconUrl(getMaterialFolderIconId(folderPath, expanded), FALLBACK_FOLDER_ICON_URL);
}
