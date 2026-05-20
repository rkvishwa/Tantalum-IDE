import { useEffect, useState } from 'react';
import type { Models } from 'appwrite';

import { getCurrentUser } from '@/lib/auth';

import { AuthScreen } from './components/AuthScreen';
import { AppShell } from './components/AppShell';

type AppInfo = {
  appName: string;
  version: string;
  platform: string;
};

function App() {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null | undefined>(undefined);
  const [appInfo, setAppInfo] = useState<AppInfo>({ appName: 'Tantalum IDE', version: '1.0.0', platform: navigator.platform });

  useEffect(() => {
    let mounted = true;
    const desktopApp = (window as typeof window & { tantalum?: { app?: { getInfo?: () => Promise<AppInfoResult> } } }).tantalum?.app;

    if (typeof desktopApp?.getInfo === 'function') {
      void desktopApp.getInfo()
        .then((result) => {
          if (mounted && result.success) {
            setAppInfo({ appName: result.appName, version: result.version, platform: result.platform });
          }
        })
        .catch(() => {});
    }

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
    };
  }, []);

  if (user === undefined) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <p className="eyebrow">Booting</p>
          <h1>{appInfo.appName}</h1>
          <p>Loading your local workspace, Appwrite session, and desktop toolchain.</p>
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
  | { success: true; appName: string; version: string; platform: string }
  | { success: false; error: string };

export default App;
