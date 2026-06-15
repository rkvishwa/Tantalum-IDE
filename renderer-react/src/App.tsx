import { useEffect, useState } from 'react';
import type { Models } from 'appwrite';

import { getCurrentUser } from '@/lib/auth';
import { applyFullscreenDocumentClass, applyPlatformDocumentClass } from '@/lib/platformUi';
import { useBootDocumentTheme } from '@/lib/useDocumentTheme';

import { AuthScreen } from './components/AuthScreen';
import { AppShell } from './components/AppShell';

type AppInfo = {
  appName: string;
  version: string;
  platform: string;
  fullscreen: boolean;
};

function App() {
  useBootDocumentTheme();
  const [user, setUser] = useState<Models.User<Models.Preferences> | null | undefined>(undefined);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    appName: 'Tantalum IDE',
    version: '1.0.0',
    platform: navigator.platform,
    fullscreen: false,
  });

  useEffect(() => {
    applyPlatformDocumentClass(appInfo.platform);
  }, [appInfo.platform]);

  useEffect(() => {
    applyFullscreenDocumentClass(appInfo.fullscreen);
  }, [appInfo.fullscreen]);

  useEffect(() => {
    let mounted = true;
    const desktopApp = (window as typeof window & {
      tantalum?: {
        app?: {
          getInfo?: () => Promise<AppInfoResult>;
          onFullscreenChanged?: (callback: (value: boolean) => void) => () => void;
        };
      };
    }).tantalum?.app;

    if (typeof desktopApp?.getInfo === 'function') {
      void desktopApp.getInfo()
        .then((result) => {
          if (mounted && result.success) {
            setAppInfo({
              appName: result.appName,
              version: result.version,
              platform: result.platform,
              fullscreen: result.fullscreen,
            });
          }
        })
        .catch(() => {});
    }

    const unsubscribeFullscreen = typeof desktopApp?.onFullscreenChanged === 'function'
      ? desktopApp.onFullscreenChanged((isFullscreen) => {
          if (mounted) {
            setAppInfo((current) => ({ ...current, fullscreen: isFullscreen }));
          }
        })
      : undefined;

    void getCurrentUser()
      .then((resolvedUser) => {
        if (mounted) {
          setUser(resolvedUser);
        }
      })
      .catch(() => {
        if (mounted) {
          setUser(null);
        }
      });

    return () => {
      mounted = false;
      unsubscribeFullscreen?.();
    };
  }, []);

  if (user === undefined) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <p className="eyebrow">Booting</p>
          <h1>{appInfo.appName}</h1>
          <p>Loading your local workspace, cloud session, and desktop toolchain.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen appName={appInfo.appName} onAuthenticated={setUser} />;
  }

  return <AppShell appName={appInfo.appName} version={appInfo.version} platform={appInfo.platform} user={user} onSignedOut={() => setUser(null)} />;
}

type AppInfoResult =
  | { success: true; appName: string; version: string; platform: string; fullscreen: boolean }
  | { success: false; error: string };

export default App;
