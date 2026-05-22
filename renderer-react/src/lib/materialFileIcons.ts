import materialIconThemeDefinition from 'material-icon-theme/dist/material-icons.json';
import appwriteIconSvg from 'material-icon-theme/icons/appwrite.svg?raw';
import arduinoIconSvg from 'material-icon-theme/icons/arduino.svg?raw';
import cIconSvg from 'material-icon-theme/icons/c.svg?raw';
import consoleIconSvg from 'material-icon-theme/icons/console.svg?raw';
import cppIconSvg from 'material-icon-theme/icons/cpp.svg?raw';
import cssIconSvg from 'material-icon-theme/icons/css.svg?raw';
import databaseIconSvg from 'material-icon-theme/icons/database.svg?raw';
import documentIconSvg from 'material-icon-theme/icons/document.svg?raw';
import eslintIconSvg from 'material-icon-theme/icons/eslint.svg?raw';
import fileIconSvg from 'material-icon-theme/icons/file.svg?raw';
import gitIconSvg from 'material-icon-theme/icons/git.svg?raw';
import hIconSvg from 'material-icon-theme/icons/h.svg?raw';
import hppIconSvg from 'material-icon-theme/icons/hpp.svg?raw';
import htmlIconSvg from 'material-icon-theme/icons/html.svg?raw';
import imageIconSvg from 'material-icon-theme/icons/image.svg?raw';
import javascriptIconSvg from 'material-icon-theme/icons/javascript.svg?raw';
import jsonIconSvg from 'material-icon-theme/icons/json.svg?raw';
import keyIconSvg from 'material-icon-theme/icons/key.svg?raw';
import licenseIconSvg from 'material-icon-theme/icons/license.svg?raw';
import lockIconSvg from 'material-icon-theme/icons/lock.svg?raw';
import logIconSvg from 'material-icon-theme/icons/log.svg?raw';
import markdownIconSvg from 'material-icon-theme/icons/markdown.svg?raw';
import nodejsIconSvg from 'material-icon-theme/icons/nodejs.svg?raw';
import npmIconSvg from 'material-icon-theme/icons/npm.svg?raw';
import pdfIconSvg from 'material-icon-theme/icons/pdf.svg?raw';
import powershellIconSvg from 'material-icon-theme/icons/powershell.svg?raw';
import prettierIconSvg from 'material-icon-theme/icons/prettier.svg?raw';
import pythonIconSvg from 'material-icon-theme/icons/python.svg?raw';
import reactIconSvg from 'material-icon-theme/icons/react.svg?raw';
import reactTsIconSvg from 'material-icon-theme/icons/react_ts.svg?raw';
import readmeIconSvg from 'material-icon-theme/icons/readme.svg?raw';
import settingsIconSvg from 'material-icon-theme/icons/settings.svg?raw';
import svgIconSvg from 'material-icon-theme/icons/svg.svg?raw';
import tailwindcssIconSvg from 'material-icon-theme/icons/tailwindcss.svg?raw';
import typescriptIconSvg from 'material-icon-theme/icons/typescript.svg?raw';
import viteIconSvg from 'material-icon-theme/icons/vite.svg?raw';
import wordIconSvg from 'material-icon-theme/icons/word.svg?raw';
import xmlIconSvg from 'material-icon-theme/icons/xml.svg?raw';
import yamlIconSvg from 'material-icon-theme/icons/yaml.svg?raw';
import zipIconSvg from 'material-icon-theme/icons/zip.svg?raw';

type MaterialIconDefinition = {
  iconPath?: string;
};

type MaterialIconTheme = {
  iconDefinitions: Record<string, MaterialIconDefinition>;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  file?: string;
};

const materialIconTheme = materialIconThemeDefinition as MaterialIconTheme;

const materialIconSvgsByFileName: Record<string, string> = {
  'appwrite.svg': appwriteIconSvg,
  'arduino.svg': arduinoIconSvg,
  'c.svg': cIconSvg,
  'console.svg': consoleIconSvg,
  'cpp.svg': cppIconSvg,
  'css.svg': cssIconSvg,
  'database.svg': databaseIconSvg,
  'document.svg': documentIconSvg,
  'eslint.svg': eslintIconSvg,
  'file.svg': fileIconSvg,
  'git.svg': gitIconSvg,
  'h.svg': hIconSvg,
  'hpp.svg': hppIconSvg,
  'html.svg': htmlIconSvg,
  'image.svg': imageIconSvg,
  'javascript.svg': javascriptIconSvg,
  'json.svg': jsonIconSvg,
  'key.svg': keyIconSvg,
  'license.svg': licenseIconSvg,
  'lock.svg': lockIconSvg,
  'log.svg': logIconSvg,
  'markdown.svg': markdownIconSvg,
  'nodejs.svg': nodejsIconSvg,
  'npm.svg': npmIconSvg,
  'pdf.svg': pdfIconSvg,
  'powershell.svg': powershellIconSvg,
  'prettier.svg': prettierIconSvg,
  'python.svg': pythonIconSvg,
  'react.svg': reactIconSvg,
  'react_ts.svg': reactTsIconSvg,
  'readme.svg': readmeIconSvg,
  'settings.svg': settingsIconSvg,
  'svg.svg': svgIconSvg,
  'tailwindcss.svg': tailwindcssIconSvg,
  'typescript.svg': typescriptIconSvg,
  'vite.svg': viteIconSvg,
  'word.svg': wordIconSvg,
  'xml.svg': xmlIconSvg,
  'yaml.svg': yamlIconSvg,
  'zip.svg': zipIconSvg,
};

const materialIconUrlsByFileName = Object.fromEntries(Object.entries(materialIconSvgsByFileName).map(([fileName, svg]) => [fileName, createSvgDataUrl(svg)]));

const materialFileNameIcons = createCaseInsensitiveMap(materialIconTheme.fileNames);
const materialFileExtensionIcons = createCaseInsensitiveMap(materialIconTheme.fileExtensions);
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
  return iconPath?.split('/').pop() ?? `${iconId}.svg`;
}

function resolveIconUrl(iconId?: string) {
  const iconFileName = resolveIconFileName(iconId);
  return materialIconUrlsByFileName[iconFileName] ?? materialIconUrlsByFileName['file.svg'] ?? '';
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

export function getMaterialFileIconUrl(filePath: string) {
  return resolveIconUrl(getMaterialFileIconId(filePath));
}

export function getMaterialFileIconSvg(filePath: string) {
  return resolveIconSvg(getMaterialFileIconId(filePath));
}
