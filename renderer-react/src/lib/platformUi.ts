export function isMacPlatform(platform: string) {
  return platform === 'darwin';
}

export function applyPlatformDocumentClass(platform: string) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.platform = platform;
  document.documentElement.classList.toggle('platform-mac', isMacPlatform(platform));
}

export function applyFullscreenDocumentClass(isFullscreen: boolean) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.classList.toggle('is-fullscreen', isFullscreen);
}

export function formatMenuShortcut(shortcut: string, platform: string) {
  if (!isMacPlatform(platform)) {
    return shortcut;
  }

  return shortcut
    .replace(/\bCtrl Shift\b/g, '⌘⇧')
    .replace(/\bCtrl\b/g, '⌘');
}

export function getRevealInFolderLabel(platform: string) {
  return isMacPlatform(platform) ? 'Reveal in Finder' : 'Reveal in File Explorer';
}
