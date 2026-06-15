'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { currentUser } from '@/lib/appwrite';
import { config } from '@/lib/config';
import { executeFunction } from '@/lib/functions';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/Button';
import { Banner } from '@/components/ui/Banner';
import { Eyebrow } from '@/components/ui/Section';

type GrantResponse = {
  grantId: string;
  expiresAt: string;
  callbackUrl: string;
};

export function DesktopAuthPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState('Checking your web session...');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [variant, setVariant] = useState<'info' | 'success' | 'error' | 'warning'>('info');

  const query = useMemo(() => {
    const state = searchParams.get('state') || '';
    const codeChallenge = searchParams.get('challenge') || searchParams.get('codeChallenge') || '';
    const callbackScheme = searchParams.get('scheme') || config.desktopScheme;
    return { state, codeChallenge, callbackScheme };
  }, [searchParams]);

  useEffect(() => {
    let mounted = true;

    async function run() {
      if (!query.state || !query.codeChallenge) {
        setMessage('Desktop login request is missing required values. Start login again from Tantalum IDE.');
        setVariant('error');
        return;
      }

      const user = await currentUser();
      if (!user) {
        const params = new URLSearchParams(searchParams.toString());
        params.set('desktop', '1');
        router.replace(`/login?${params.toString()}`);
        return;
      }

      if (!user.emailVerification) {
        setMessage('Verify your email address before signing in to the desktop app.');
        setVariant('warning');
        return;
      }

      try {
        const grant = await executeFunction<GrantResponse>(config.desktopAuthFunctionId, '/grant', query);
        if (!mounted) return;
        setCallbackUrl(grant.callbackUrl);
        setMessage('Opening Tantalum IDE...');
        setVariant('success');
        window.location.href = grant.callbackUrl;
      } catch (error) {
        if (!mounted) return;
        setMessage(error instanceof Error ? error.message : 'Desktop login failed.');
        setVariant('error');
      }
    }

    void run();

    return () => {
      mounted = false;
    };
  }, [query, router, searchParams]);

  return (
    <section className="auth-shell">
      <div className="auth-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <BrandLogo />
          <Eyebrow>Desktop login</Eyebrow>
        </div>
        <h1>Connect Tantalum IDE</h1>
        <Banner variant={variant}>{message}</Banner>
        {callbackUrl ? (
          <div className="auth-actions">
            <Button variant="primary" size="md" href={callbackUrl}>Open Tantalum IDE</Button>
          </div>
        ) : null}
        <p style={{ marginTop: 16, fontSize: 13 }}>
          <Link href="/dashboard" style={{ color: 'var(--accent)' }}>Go to dashboard</Link>
        </p>
      </div>
    </section>
  );
}
