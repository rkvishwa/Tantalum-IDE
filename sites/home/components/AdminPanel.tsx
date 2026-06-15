'use client';

import { useEffect, useState } from 'react';
import { config } from '@/lib/config';
import { executeFunction } from '@/lib/functions';
import type { AdminDashboard, AdminUser } from '@/lib/types';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { FormField, TextArea, TextInput } from '@/components/ui/FormField';
import { PageHeader } from '@/components/ui/Section';

type UserDetail = {
  user: AdminUser;
  entitlement: { tier: string; status: string; monthlyCredits: number; notes?: string } | null;
  boards: Array<{ id: string; name: string; status: string; firmwareVersion: string }>;
  usage: Array<{ id: string; mode: string; status: string; chargedCredits: number; createdAt: string }>;
  credits: Array<{ id: string; periodKey: string; monthlyAllowance: number; usedCredits: number }>;
};

export function AdminPanel() {
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<UserDetail | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [setting, setSetting] = useState({ key: 'agent.outputStyle', value: 'compact', description: 'Agent response style.' });
  const [entitlement, setEntitlement] = useState({ tier: 'hobby', status: 'active', monthlyCredits: '500', notes: '' });

  async function load() {
    setStatus('');
    try {
      const data = await executeFunction<AdminDashboard>(config.webAdminFunctionId, '/dashboard');
      setDashboard(data);
      setUsers(data.recentUsers);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to load admin dashboard.');
    }
  }

  async function findUsers() {
    setStatus('');
    try {
      const data = await executeFunction<{ users: AdminUser[] }>(config.webAdminFunctionId, '/users', { search, limit: 50 });
      setUsers(data.users);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'User search failed.');
    }
  }

  async function openUser(userId: string) {
    setStatus('');
    try {
      const data = await executeFunction<UserDetail>(config.webAdminFunctionId, '/users/detail', { userId });
      setSelected(data);
      setEntitlement({
        tier: data.entitlement?.tier || 'hobby',
        status: data.entitlement?.status || 'active',
        monthlyCredits: String(data.entitlement?.monthlyCredits || 500),
        notes: data.entitlement?.notes || '',
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to open user.');
    }
  }

  async function saveEntitlement() {
    if (!selected) return;
    setStatus('');
    try {
      await executeFunction(config.webAdminFunctionId, '/users/entitlement', {
        userId: selected.user.id,
        tier: entitlement.tier,
        status: entitlement.status,
        monthlyCredits: Number(entitlement.monthlyCredits || 0),
        notes: entitlement.notes,
      });
      setStatus('Entitlement updated.');
      await openUser(selected.user.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to update entitlement.');
    }
  }

  async function saveSetting() {
    setStatus('');
    try {
      await executeFunction(config.webAdminFunctionId, '/settings/upsert', setting);
      setStatus('Setting updated.');
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to update setting.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader eyebrow="Admin" title="Operations panel" />
      {status ? <Banner variant="info">{status}</Banner> : null}
      <div className="metric-grid">
        <div className="metric"><span>Users</span><strong>{dashboard?.totals.users ?? '-'}</strong></div>
        <div className="metric"><span>Boards</span><strong>{dashboard?.totals.boards ?? '-'}</strong></div>
        <div className="metric"><span>Usage events</span><strong>{dashboard?.totals.recentUsageEvents ?? '-'}</strong></div>
        <div className="metric"><span>Credits charged</span><strong>{dashboard?.totals.chargedCredits ?? '-'}</strong></div>
      </div>

      <section className="settings-card" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Users</h2>
        <div className="hero-actions">
          <TextInput style={{ maxWidth: 340 }} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by email or name" />
          <Button variant="secondary" type="button" onClick={() => void findUsers()}>Search</Button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>User</th><th>Email</th><th>Labels</th><th>Status</th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <Button variant="ghost" size="sm" type="button" onClick={() => void openUser(user.id)}>
                      {user.name || user.id}
                    </Button>
                  </td>
                  <td>{user.email}</td>
                  <td><code>{user.labels.join(', ') || '-'}</code></td>
                  <td>{user.status ? 'active' : 'disabled'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected ? (
        <section className="settings-card" style={{ marginTop: 20 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{selected.user.email}</h2>
          <div className="section-grid">
            <FormField label="Tier">
              <select value={entitlement.tier} onChange={(event) => setEntitlement((current) => ({ ...current, tier: event.target.value }))}>
                <option value="hobby">Hobby</option>
                <option value="pro">Pro</option>
                <option value="max">Max</option>
              </select>
            </FormField>
            <FormField label="Status">
              <select value={entitlement.status} onChange={(event) => setEntitlement((current) => ({ ...current, status: event.target.value }))}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="blocked">Blocked</option>
              </select>
            </FormField>
            <FormField label="Monthly credits">
              <TextInput value={entitlement.monthlyCredits} onChange={(event) => setEntitlement((current) => ({ ...current, monthlyCredits: event.target.value }))} />
            </FormField>
          </div>
          <FormField label="Notes">
            <TextArea rows={3} value={entitlement.notes} onChange={(event) => setEntitlement((current) => ({ ...current, notes: event.target.value }))} />
          </FormField>
          <div className="hero-actions">
            <Button variant="primary" type="button" onClick={() => void saveEntitlement()}>Update user</Button>
          </div>
          <h3>Boards</h3>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {selected.boards.map((board) => (
                  <tr key={board.id}>
                    <td>{board.name}</td>
                    <td>{board.status}</td>
                    <td>{board.firmwareVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="settings-card" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Global setting</h2>
        <div className="section-grid">
          <FormField label="Key">
            <TextInput value={setting.key} onChange={(event) => setSetting((current) => ({ ...current, key: event.target.value }))} />
          </FormField>
          <FormField label="Value">
            <TextInput value={setting.value} onChange={(event) => setSetting((current) => ({ ...current, value: event.target.value }))} />
          </FormField>
          <FormField label="Description">
            <TextInput value={setting.description} onChange={(event) => setSetting((current) => ({ ...current, description: event.target.value }))} />
          </FormField>
        </div>
        <div className="hero-actions">
          <Button variant="primary" type="button" onClick={() => void saveSetting()}>Save setting</Button>
        </div>
      </section>
    </>
  );
}
