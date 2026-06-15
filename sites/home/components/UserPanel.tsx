'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCcw } from 'lucide-react';
import { Query, databases } from '@/lib/appwrite';
import { config } from '@/lib/config';
import { executeFunction } from '@/lib/functions';
import type { AgentSettingsState, BoardDocument, FirmwareDocument } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Section';

function time(value?: string | null) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

export function DashboardPanel() {
  const [boards, setBoards] = useState<BoardDocument[]>([]);
  const [agent, setAgent] = useState<AgentSettingsState | null>(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const [boardResponse, agentResponse] = await Promise.all([
        databases.listDocuments<BoardDocument>(config.databaseId, config.boardsCollectionId, [Query.limit(100), Query.orderDesc('createdAt')]),
        executeFunction<AgentSettingsState>(config.agentSettingsFunctionId, '/bootstrap', { includeUsage: true }),
      ]);
      setBoards(boardResponse.documents);
      setAgent(agentResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load dashboard.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const online = boards.filter((board) => board.status === 'online' || board.status === 'connected').length;
  const credits = agent?.creditAccount;

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title="Cloud overview"
        actions={
          <Button variant="secondary" type="button" onClick={() => void load()}>
            <RefreshCcw size={14} /> Refresh
          </Button>
        }
      />
      {error ? <Banner variant="error">{error}</Banner> : null}
      <div className="metric-grid">
        <div className="metric"><span>Tier</span><strong>Hobby</strong></div>
        <div className="metric"><span>Cloud boards</span><strong>{boards.length}</strong></div>
        <div className="metric"><span>Online</span><strong>{online}</strong></div>
        <div className="metric"><span>Agent credits</span><strong>{credits ? `${credits.remainingCredits}/${credits.monthlyAllowance}` : '-'}</strong></div>
      </div>
      <section className="settings-card" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Recent boards</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Status</th><th>Firmware</th><th>Last seen</th></tr></thead>
            <tbody>
              {boards.slice(0, 8).map((board) => (
                <tr key={board.$id}>
                  <td><Link href={`/boards/${board.$id}`}>{board.name}</Link></td>
                  <td><Badge>{board.status || 'pending'}</Badge></td>
                  <td>{board.firmwareVersion || '-'}</td>
                  <td>{time(board.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function BoardsPanel() {
  const [boards, setBoards] = useState<BoardDocument[]>([]);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const response = await databases.listDocuments<BoardDocument>(config.databaseId, config.boardsCollectionId, [Query.limit(100), Query.orderDesc('createdAt')]);
      setBoards(response.documents);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load cloud boards.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader eyebrow="Cloud Boards" title="Manage registered boards" />
      {error ? <Banner variant="error">{error}</Banner> : null}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Board</th><th>Status</th><th>OTA</th><th>Last seen</th></tr></thead>
          <tbody>
            {boards.map((board) => (
              <tr key={board.$id}>
                <td><Link href={`/boards/${board.$id}`}>{board.name}</Link></td>
                <td><code>{board.boardType}</code></td>
                <td><Badge>{board.status || 'pending'}</Badge></td>
                <td>{board.otaStatus || 'idle'}</td>
                <td>{time(board.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function BoardDetailPanel({ boardId }: { boardId: string }) {
  const [board, setBoard] = useState<BoardDocument | null>(null);
  const [firmware, setFirmware] = useState<FirmwareDocument[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const [resolvedBoard, releases] = await Promise.all([
        databases.getDocument<BoardDocument>(config.databaseId, config.boardsCollectionId, boardId),
        databases.listDocuments<FirmwareDocument>(config.databaseId, config.firmwareCollectionId, [Query.equal('boardId', boardId), Query.limit(100), Query.orderDesc('uploadedAt')]),
      ]);
      setBoard(resolvedBoard);
      setFirmware(releases.documents);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load board.');
    }
  }

  async function rotateToken() {
    setStatus('');
    try {
      await executeFunction(config.boardAdminFunctionId, '/rotate-token', { boardId });
      setStatus('Board token rotated. Re-provision the board from the desktop IDE before using cloud runtime commands.');
      await load();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : 'Token rotation failed.');
    }
  }

  async function deploy(firmwareId: string) {
    setStatus('');
    try {
      await executeFunction(config.boardAdminFunctionId, '/deploy-firmware', {
        boardId,
        firmwareId,
        deploymentId: `web_${Date.now()}`,
      });
      setStatus('Firmware deployment queued.');
      await load();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : 'Deployment failed.');
    }
  }

  useEffect(() => {
    void load();
  }, [boardId]);

  if (error) {
    return <Banner variant="error">{error}</Banner>;
  }

  if (!board) {
    return <p>Loading board...</p>;
  }

  return (
    <>
      <PageHeader eyebrow="Board" title={board.name} />
      {status ? <Banner variant="info">{status}</Banner> : null}
      <div className="metric-grid">
        <div className="metric"><span>Status</span><strong>{board.status || 'pending'}</strong></div>
        <div className="metric"><span>OTA</span><strong>{board.otaStatus || 'idle'}</strong></div>
        <div className="metric"><span>Firmware</span><strong>{board.firmwareVersion || '-'}</strong></div>
        <div className="metric"><span>Token</span><strong><code>{board.tokenPreview || '-'}</code></strong></div>
      </div>
      <div className="hero-actions">
        <Button variant="secondary" type="button" onClick={() => void rotateToken()}>Rotate token</Button>
      </div>
      <section className="settings-card" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Firmware releases</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Version</th><th>File</th><th>Uploaded</th><th>Status</th><th /></tr></thead>
            <tbody>
              {firmware.map((release) => (
                <tr key={release.$id}>
                  <td>{release.version}</td>
                  <td>{release.filename}</td>
                  <td>{time(release.uploadedAt)}</td>
                  <td>{release.deployed ? <Badge variant="success">Desired</Badge> : 'Available'}</td>
                  <td>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => void deploy(release.$id)}
                      disabled={release.deployed}
                    >
                      Deploy
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function AgentsPanel() {
  const [settings, setSettings] = useState<AgentSettingsState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void executeFunction<AgentSettingsState>(config.agentSettingsFunctionId, '/bootstrap', { includeUsage: true })
      .then(setSettings)
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load agent settings.'));
  }, []);

  const usage = settings?.recentUsage || [];
  const credits = settings?.creditAccount;
  const usedPercent = useMemo(() => {
    if (!credits?.monthlyAllowance) return 0;
    return Math.min(100, Math.round((credits.usedCredits / credits.monthlyAllowance) * 100));
  }, [credits]);

  return (
    <>
      <PageHeader eyebrow="Agents" title="Usage and threads" />
      {error ? <Banner variant="error">{error}</Banner> : null}
      <div className="metric-grid">
        <div className="metric"><span>Managed models</span><strong>{settings?.managedAvailable ? 'On' : 'Off'}</strong></div>
        <div className="metric"><span>Credits used</span><strong>{credits ? `${credits.usedCredits}` : '-'}</strong></div>
        <div className="metric"><span>Credits left</span><strong>{credits ? `${credits.remainingCredits}` : '-'}</strong></div>
        <div className="metric"><span>Usage</span><strong>{usedPercent}%</strong></div>
      </div>
      <section className="settings-card" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Recent usage</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Mode</th><th>Status</th><th>Tokens</th><th>Credits</th><th>Created</th></tr></thead>
            <tbody>
              {usage.map((event) => (
                <tr key={event.id}>
                  <td><code>{event.source} / {event.mode}</code></td>
                  <td>{event.status}</td>
                  <td>{event.totalTokens}</td>
                  <td>{event.chargedCredits}</td>
                  <td>{time(event.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
