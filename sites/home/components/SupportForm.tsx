'use client';

import { useState } from 'react';
import { ID, Permission, Role, currentUser, databases } from '@/lib/appwrite';
import { config } from '@/lib/config';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { FormField, TextArea, TextInput } from '@/components/ui/FormField';

export function SupportForm() {
  const [form, setForm] = useState({ subject: '', message: '' });
  const [status, setStatus] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    setIsSuccess(false);
    try {
      const user = await currentUser();
      if (!user) {
        setStatus('Login before sending authenticated support requests.');
        return;
      }

      const now = new Date().toISOString();
      await databases.createDocument(config.databaseId, config.supportTicketsCollectionId, ID.unique(), {
        userId: user.$id,
        subject: form.subject.trim(),
        message: form.message.trim(),
        status: 'open',
        priority: 'normal',
        createdAt: now,
        updatedAt: now,
      }, [
        Permission.read(Role.user(user.$id)),
        Permission.update(Role.user(user.$id)),
      ]);
      setStatus('Support request sent.');
      setIsSuccess(true);
      setForm({ subject: '', message: '' });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to send support request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <FormField label="Subject">
        <TextInput
          value={form.subject}
          onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))}
          required
        />
      </FormField>
      <FormField label="Message">
        <TextArea
          rows={6}
          value={form.message}
          onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))}
          required
        />
      </FormField>
      {status ? <Banner variant={isSuccess ? 'success' : 'error'}>{status}</Banner> : null}
      <Button variant="primary" size="md" type="submit" disabled={busy}>
        {busy ? 'Sending...' : 'Send support request'}
      </Button>
    </form>
  );
}
