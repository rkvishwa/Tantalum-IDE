'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { account, currentUser, ID } from '@/lib/appwrite';
import { config, siteUrl } from '@/lib/config';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/Button';
import { Banner } from '@/components/ui/Banner';
import { Eyebrow } from '@/components/ui/Section';
import { FormField, TextInput } from '@/components/ui/FormField';

type Mode = 'login' | 'register';

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const desktopRedirect = searchParams.get('desktop') === '1' ? `/auth/desktop?${searchParams.toString()}` : '/dashboard';
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const title = mode === 'login' ? 'Login to Tantalum' : 'Create your Tantalum account';

  useEffect(() => {
    void currentUser().then((user) => {
      if (user) {
        router.replace(desktopRedirect);
      }
    });
  }, [desktopRedirect, router]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setIsSuccess(false);
    try {
      if (mode === 'register') {
        await account.create(ID.unique(), form.email.trim(), form.password, form.name.trim());
      }

      await account.createEmailSession(form.email.trim(), form.password);

      if (mode === 'register') {
        await account.createVerification(siteUrl('/verify')).catch(() => undefined);
        setMessage('Account created. Check your email to verify your account before using desktop login.');
        setIsSuccess(true);
        return;
      }

      router.replace(desktopRedirect);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  function oauth(provider: 'google' | 'github') {
    const success = siteUrl(desktopRedirect);
    const failure = siteUrl(`/login?error=oauth&desktop=${searchParams.get('desktop') || ''}`);
    const url = account.createOAuth2Session(provider, success, failure);
    if (url) {
      window.location.href = url.toString();
    }
  }

  return (
    <section className="auth-shell">
      <div className="auth-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <BrandLogo />
          <Eyebrow>{config.appName}</Eyebrow>
        </div>
        <h1>{title}</h1>
        <form className="form" onSubmit={submit}>
          {mode === 'register' ? (
            <FormField label="Full name">
              <TextInput
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                required
              />
            </FormField>
          ) : null}
          <FormField label="Email">
            <TextInput
              type="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              required
            />
          </FormField>
          <FormField label="Password">
            <TextInput
              type="password"
              minLength={8}
              value={form.password}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
              required
            />
          </FormField>
          {message ? (
            <Banner variant={isSuccess ? 'success' : 'error'}>{message}</Banner>
          ) : null}
          <Button variant="primary" size="md" type="submit" disabled={busy}>
            {busy ? 'Working...' : mode === 'login' ? 'Login' : 'Create account'}
          </Button>
        </form>
        <div className="oauth-grid">
          <Button variant="secondary" type="button" onClick={() => oauth('google')}>Continue with Google</Button>
          <Button variant="secondary" type="button" onClick={() => oauth('github')}>Continue with GitHub</Button>
        </div>
        <p style={{ marginTop: 16, fontSize: 13 }}>
          {mode === 'login' ? (
            <>
              New here? <Link href="/register" style={{ color: 'var(--accent)' }}>Create an account</Link>.{' '}
              <Link href="/reset" style={{ color: 'var(--accent)' }}>Reset password</Link>.
            </>
          ) : (
            <>
              Already have an account? <Link href="/login" style={{ color: 'var(--accent)' }}>Login</Link>.
            </>
          )}
        </p>
      </div>
    </section>
  );
}

export function VerifyEmailPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState('Verifying your email...');
  const [variant, setVariant] = useState<'info' | 'success' | 'error'>('info');

  useEffect(() => {
    const userId = searchParams.get('userId') || '';
    const secret = searchParams.get('secret') || '';
    if (!userId || !secret) {
      setMessage('Verification link is missing required values.');
      setVariant('error');
      return;
    }

    void account.updateVerification(userId, secret)
      .then(() => {
        setMessage('Email verified. Redirecting to your dashboard...');
        setVariant('success');
        setTimeout(() => router.replace('/dashboard'), 900);
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : 'Verification failed.');
        setVariant('error');
      });
  }, [router, searchParams]);

  return <StatusCard title="Email verification" message={message} variant={variant} />;
}

export function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const hasToken = useMemo(() => Boolean(searchParams.get('userId') && searchParams.get('secret')), [searchParams]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setIsSuccess(false);
    try {
      if (hasToken) {
        await account.updateRecovery(searchParams.get('userId') || '', searchParams.get('secret') || '', password, password);
        setMessage('Password updated. You can login with the new password.');
        setIsSuccess(true);
      } else {
        await account.createRecovery(email.trim(), siteUrl('/reset'));
        setMessage('Password reset email sent.');
        setIsSuccess(true);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Password reset failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-shell">
      <div className="auth-panel">
        <Eyebrow>Account recovery</Eyebrow>
        <h1>{hasToken ? 'Choose a new password' : 'Reset your password'}</h1>
        <form className="form" onSubmit={submit}>
          {hasToken ? (
            <FormField label="New password">
              <TextInput
                type="password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </FormField>
          ) : (
            <FormField label="Email">
              <TextInput
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </FormField>
          )}
          {message ? <Banner variant={isSuccess ? 'success' : 'error'}>{message}</Banner> : null}
          <Button variant="primary" size="md" type="submit" disabled={busy}>
            {busy ? 'Working...' : 'Continue'}
          </Button>
        </form>
      </div>
    </section>
  );
}

function StatusCard({
  title,
  message,
  variant = 'info',
}: {
  title: string;
  message: string;
  variant?: 'info' | 'success' | 'error';
}) {
  return (
    <section className="auth-shell">
      <div className="auth-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <BrandLogo />
          <Eyebrow>Tantalum IDE</Eyebrow>
        </div>
        <h1>{title}</h1>
        <Banner variant={variant}>{message}</Banner>
      </div>
    </section>
  );
}
