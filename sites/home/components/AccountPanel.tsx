'use client';

import { useEffect, useState } from 'react';
import { account, currentUser } from '@/lib/appwrite';
import type { User } from '@/lib/types';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Section';

export function AccountPanel() {
  const [user, setUser] = useState<User | null>(null);
  const [message, setMessage] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    void currentUser().then(setUser);
  }, []);

  async function sendVerification() {
    setMessage('');
    setIsSuccess(false);
    try {
      await account.createVerification(`${window.location.origin}/verify`);
      setMessage('Verification email sent.');
      setIsSuccess(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to send verification email.');
    }
  }

  if (!user) {
    return <p>Loading account...</p>;
  }

  return (
    <>
      <PageHeader eyebrow="Account" title={user.name || user.email} />
      {message ? <Banner variant={isSuccess ? 'success' : 'error'}>{message}</Banner> : null}
      <div className="section-grid">
        <Card title="Email"><p>{user.email}</p></Card>
        <Card title="Email verified"><p>{user.emailVerification ? 'Yes' : 'No'}</p></Card>
        <Card title="Tier"><p>Hobby</p></Card>
      </div>
      {!user.emailVerification ? (
        <div className="hero-actions">
          <Button variant="primary" type="button" onClick={() => void sendVerification()}>
            Send verification email
          </Button>
        </div>
      ) : null}
    </>
  );
}
