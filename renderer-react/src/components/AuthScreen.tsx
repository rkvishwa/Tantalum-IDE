import { useEffect, useState } from 'react';
import type { Models } from 'appwrite';

import { appwriteConfig, hasRequiredCloudConfiguration } from '@/lib/config';
import { startWebLogin } from '@/lib/auth';
import { useDocumentTheme } from '@/lib/useDocumentTheme';
import tantalumIcon from '@/assets/tantalum-icon.svg';
import tantalumIconDark from '@/assets/tantalum-icon-dark.svg';

type AuthScreenProps = {
  appName: string;
  onAuthenticated: (user: Models.User<Models.Preferences>) => void;
};

function formatAuthError(caughtError: unknown) {
  const message = caughtError instanceof Error ? caughtError.message : 'Unable to reach the cloud service.';

  if (/network request failed|failed to fetch/i.test(message)) {
    return `Unable to reach the cloud service at ${appwriteConfig.endpoint}. Restart the app and verify the endpoint is reachable from this machine.`;
  }

  return message;
}

export function AuthScreen({ appName, onAuthenticated }: AuthScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const resolvedTheme = useDocumentTheme();
  const canUseCloud = hasRequiredCloudConfiguration();

  useEffect(() => {
    const unsubscribe = window.tantalum?.cloud?.auth?.onWebLoginResult?.((result) => {
      setBusy(false);
      if (result.success) {
        onAuthenticated(result.user);
        return;
      }

      setError(result.error || 'Web login failed.');
      setStatus(null);
    });

    return () => {
      unsubscribe?.();
    };
  }, [onAuthenticated]);

  async function handleWebLogin() {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const result = await startWebLogin();
      setStatus(`Continue in your browser. This login request expires at ${new Date(result.expiresAt).toLocaleTimeString()}.`);
    } catch (caughtError) {
      setError(formatAuthError(caughtError));
      setBusy(false);
    }
  }

  async function openCreateAccount() {
    if (!appwriteConfig.webAppUrl) {
      return;
    }

    await window.tantalum?.shell?.openExternal?.(`${appwriteConfig.webAppUrl}/register`);
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="brand-mark">
          <img className="brand-icon" src={resolvedTheme === 'dark' ? tantalumIconDark : tantalumIcon} alt="" />
          <span className="brand-text">{appName}</span>
        </div>
        <div className="auth-copy">
          <p className="eyebrow">Desktop control room</p>
          <h1>Sign in through the Tantalum web portal.</h1>
          <p>
            Account creation, email verification, password reset, Google login, and GitHub login now happen in the browser.
            The IDE receives a short-lived cloud session after the web login succeeds.
          </p>
        </div>

        {!canUseCloud ? (
          <div className="inline-banner inline-banner-warning">
            Cloud configuration is incomplete. Update the local cloud settings before using authentication or cloud features.
          </div>
        ) : null}

        {error ? <div className="inline-banner inline-banner-error">{error}</div> : null}
        {status ? <div className="inline-banner">{status}</div> : null}

        <div className="auth-form">
          <button className="primary-button" type="button" onClick={() => void handleWebLogin()} disabled={busy || !canUseCloud}>
            {busy ? 'Waiting for browser login...' : 'Login from web'}
          </button>
          <button className="secondary-button" type="button" onClick={() => void openCreateAccount()} disabled={!canUseCloud}>
            Create account on web
          </button>
        </div>
      </div>
    </div>
  );
}
