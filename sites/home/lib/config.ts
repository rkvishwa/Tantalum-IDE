export const config = {
  appName: 'Tantalum IDE',
  endpoint: process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || 'https://api.metl.run/v1',
  projectId: process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || 'tantalum',
  databaseId: process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || '697b8f660033fffde4be',
  boardsCollectionId: process.env.NEXT_PUBLIC_APPWRITE_BOARDS_COLLECTION_ID || 'boards',
  firmwareCollectionId: process.env.NEXT_PUBLIC_APPWRITE_FIRMWARE_COLLECTION_ID || 'firmwares',
  agentSettingsFunctionId: process.env.NEXT_PUBLIC_APPWRITE_AGENT_SETTINGS_FUNCTION_ID || 'agent-settings',
  boardAdminFunctionId: process.env.NEXT_PUBLIC_APPWRITE_BOARD_ADMIN_FUNCTION_ID || 'board-admin',
  desktopAuthFunctionId: process.env.NEXT_PUBLIC_APPWRITE_DESKTOP_AUTH_FUNCTION_ID || 'desktop-auth',
  webAdminFunctionId: process.env.NEXT_PUBLIC_APPWRITE_WEB_ADMIN_FUNCTION_ID || 'web-admin',
  supportTicketsCollectionId: process.env.NEXT_PUBLIC_APPWRITE_SUPPORT_TICKETS_COLLECTION_ID || 'support_tickets',
  desktopScheme: process.env.NEXT_PUBLIC_TANTALUM_DESKTOP_SCHEME || 'tantalum',
  downloadUrls: {
    windows: process.env.NEXT_PUBLIC_TANTALUM_WINDOWS_DOWNLOAD_URL || '',
    macos: process.env.NEXT_PUBLIC_TANTALUM_MACOS_DOWNLOAD_URL || '',
    linux: process.env.NEXT_PUBLIC_TANTALUM_LINUX_DOWNLOAD_URL || '',
  },
};

export function siteUrl(path = '/') {
  const base = typeof window === 'undefined' ? process.env.NEXT_PUBLIC_TANTALUM_WEB_APP_URL || '' : window.location.origin;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
