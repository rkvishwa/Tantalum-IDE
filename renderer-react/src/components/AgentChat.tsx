import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Models } from 'appwrite';
import { DiffEditor } from '@monaco-editor/react';
import {
  Bot,
  Check,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Send,
  Settings2,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';

import {
  createCustomCredential,
  createDefaultAgentSettings,
  deleteCustomCredential,
  loadAgentSettings,
  normalizeModelList,
  saveAgentPreferences,
  testCustomCredential,
  updateCustomCredential,
  type AgentCredentialInput,
  type AgentCustomCredential,
  type AgentPreferences,
  type AgentSettingsState,
  type AgentUiMessage,
} from '@/lib/agent';
import { hasAgentCloudConfiguration } from '@/lib/config';
import { joinPath } from '@/lib/utils';
import type { AgentApprovalRequest, AgentApprovalResolution, AgentChangePreview } from '@/types/electron';

import { MarkdownRenderer } from './MarkdownRenderer';
import { Modal } from './Modal';

type AgentPanelProps = {
  user: Models.User<Models.Preferences>;
  workspacePath: string | null;
  activeTab: {
    path: string;
    name: string;
    content: string;
    isDirty: boolean;
  } | null;
  onFileContentApplied: (filePath: string, content: string) => void;
  onPathDeleted: (filePath: string, isDirectory: boolean) => void;
  onRefreshWorkspace: () => void;
  pushConsole: (message: string, level?: 'info' | 'success' | 'error') => void;
  pushToast: (message: string, tone?: 'info' | 'success' | 'error') => void;
};

type AgentView = 'chat' | 'settings' | 'usage';

type CredentialFormState = {
  credentialId: string | null;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  modelNames: string;
  enabled: boolean;
};

const INITIAL_MESSAGE: AgentUiMessage = {
  id: 'agent-welcome',
  role: 'assistant',
  content: 'Ask me to inspect or change the workspace. I run Aider in a sandbox and pause before touching your real files.',
};

const EMPTY_CREDENTIAL_FORM: CredentialFormState = {
  credentialId: null,
  displayName: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelNames: '',
  enabled: true,
};

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return 'Never';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatCredits(value: number) {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

function firstEnabledCredential(settings: AgentSettingsState) {
  return settings.customCredentials.find((credential) => credential.enabled) ?? null;
}

export function AgentPanel({
  user,
  workspacePath,
  activeTab,
  onFileContentApplied,
  onPathDeleted,
  onRefreshWorkspace,
  pushConsole,
  pushToast,
}: AgentPanelProps) {
  const [view, setView] = useState<AgentView>('chat');
  const [messages, setMessages] = useState<AgentUiMessage[]>([INITIAL_MESSAGE]);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [settings, setSettings] = useState<AgentSettingsState>(() => createDefaultAgentSettings());
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<AgentApprovalRequest | null>(null);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedReviewPath, setSelectedReviewPath] = useState<string | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(EMPTY_CREDENTIAL_FORM);
  const [agentSetupMessage, setAgentSetupMessage] = useState<string | null>(null);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const deferredPrompt = useDeferredValue(draftPrompt);
  const hasCloudAgent = hasAgentCloudConfiguration();
  const preferences = settings.preferences;
  const enabledCustomCredentials = useMemo(
    () => settings.customCredentials.filter((credential) => credential.enabled),
    [settings.customCredentials],
  );
  const selectedCredential = useMemo(() => {
    if (!preferences.selectedCustomCredentialId) {
      return firstEnabledCredential(settings);
    }

    return settings.customCredentials.find((credential) => credential.id === preferences.selectedCustomCredentialId) ?? firstEnabledCredential(settings);
  }, [preferences.selectedCustomCredentialId, settings]);
  const selectedModel =
    preferences.selectedCustomModelName && selectedCredential?.modelNames.includes(preferences.selectedCustomModelName)
      ? preferences.selectedCustomModelName
      : selectedCredential?.modelNames[0] ?? null;
  const selectedReviewFile = useMemo(() => {
    const files = pendingApproval?.preview.kind === 'agent-run' ? pendingApproval.preview.files : [];
    if (selectedReviewPath) {
      return files.find((file) => file.path === selectedReviewPath) ?? files[0] ?? null;
    }

    return files[0] ?? null;
  }, [pendingApproval, selectedReviewPath]);

  const canUseManaged = settings.managedAvailable && settings.creditAccount.remainingCredits > 0;
  const canUseCustom = Boolean(selectedCredential && selectedModel);
  const canSend =
    Boolean(workspacePath) &&
    hasCloudAgent &&
    !busy &&
    !pendingApproval &&
    deferredPrompt.trim().length > 0 &&
    (preferences.selectedSource === 'managed' ? canUseManaged : canUseCustom);

  const appendUiMessage = useCallback((message: AgentUiMessage) => {
    startTransition(() => {
      setMessages((current) => [...current, message]);
    });
  }, []);

  const refreshAgentSettings = useCallback(async (showErrors = true) => {
    if (!hasCloudAgent) {
      setSettings(createDefaultAgentSettings());
      setLoadingSettings(false);
      return;
    }

    setLoadingSettings(true);
    try {
      const nextSettings = await loadAgentSettings();
      setSettings(nextSettings);
    } catch (error) {
      if (showErrors) {
        const message = error instanceof Error ? error.message : 'Unable to load agent settings.';
        appendUiMessage({ id: createMessageId('settings-error'), role: 'status', content: message, tone: 'error' });
      }
    } finally {
      setLoadingSettings(false);
    }
  }, [appendUiMessage, hasCloudAgent]);

  async function persistPreferences(nextPreferences: AgentPreferences) {
    setSettings((current) => ({ ...current, preferences: nextPreferences }));

    if (!hasCloudAgent) {
      return;
    }

    try {
      const saved = await saveAgentPreferences(nextPreferences);
      setSettings((current) => ({ ...current, preferences: saved }));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to save agent preferences.', 'error');
    }
  }

  function syncAgentApplySideEffects(resolution: { meta?: Record<string, unknown> }) {
    const files = Array.isArray(resolution.meta?.files) ? resolution.meta.files : [];
    if (!workspacePath || files.length === 0) {
      return;
    }

    files.forEach((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
        return;
      }

      const targetPath = joinPath(workspacePath, entry.path);
      if (entry.changeType === 'delete') {
        onPathDeleted(targetPath, false);
        return;
      }

      if (typeof entry.content === 'string') {
        onFileContentApplied(targetPath, entry.content);
      }
    });

    onRefreshWorkspace();
  }

  async function handleSendPrompt() {
    const prompt = draftPrompt.trim();
    if (!prompt) {
      return;
    }

    if (!workspacePath) {
      pushToast('Open a workspace before starting the agent.', 'info');
      return;
    }

    if (preferences.selectedSource === 'custom' && (!selectedCredential || !selectedModel)) {
      pushToast('Choose an enabled custom credential and model first.', 'info');
      setView('settings');
      return;
    }

    setDraftPrompt('');
    appendUiMessage({ id: createMessageId('user'), role: 'user', content: prompt });
    setBusy(true);

    try {
      const status = await window.tantalum.agent.getStatus();
      if (status.success) {
        setAgentSetupMessage(status.setup.message);
      }

      const result = await window.tantalum.agent.run({
        prompt,
        source: preferences.selectedSource,
        mode: preferences.defaultMode,
        customCredentialId: preferences.selectedSource === 'custom' ? selectedCredential?.id : null,
        customModelName: preferences.selectedSource === 'custom' ? selectedModel : null,
        activeTab,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      pushConsole(result.output, 'info');
      appendUiMessage({
        id: createMessageId('assistant'),
        role: 'assistant',
        content:
          result.changedFiles.length > 0
            ? `${result.output}\n\nPrepared ${result.changedFiles.length} workspace ${result.changedFiles.length === 1 ? 'change' : 'changes'} for review.`
            : result.output,
      });

      if (result.requiresApproval && result.approval) {
        setPendingApproval(result.approval);
        setSelectedReviewPath(result.approval.preview.kind === 'agent-run' ? result.approval.preview.files[0]?.path ?? null : null);
        setReviewModalOpen(true);
      }

      await refreshAgentSettings(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The agent run failed.';
      appendUiMessage({ id: createMessageId('error'), role: 'status', content: message, tone: 'error' });
      pushToast(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApproval(approved: boolean) {
    if (!pendingApproval) {
      return;
    }

    setBusy(true);
    try {
      const resolution = await window.tantalum.agent.resolveApproval({
        requestId: pendingApproval.requestId,
        approved,
      });

      appendUiMessage({
        id: createMessageId('approval'),
        role: 'status',
        content: describeApprovalResolution(resolution),
        tone: resolution.success && resolution.approved ? 'success' : approved ? 'error' : 'warning',
      });

      if (resolution.success && resolution.approved) {
        syncAgentApplySideEffects(resolution);
      }

      setPendingApproval(null);
      setReviewModalOpen(false);
      setSelectedReviewPath(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to resolve the approval request.';
      pushToast(message, 'error');
      appendUiMessage({ id: createMessageId('approval-error'), role: 'status', content: message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function startEditingCredential(credential: AgentCustomCredential) {
    setCredentialForm({
      credentialId: credential.id,
      displayName: credential.displayName,
      baseUrl: credential.baseUrl,
      apiKey: '',
      modelNames: credential.modelNames.join('\n'),
      enabled: credential.enabled,
    });
  }

  async function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const modelNames = normalizeModelList(credentialForm.modelNames);
    const input: AgentCredentialInput = {
      displayName: credentialForm.displayName.trim(),
      baseUrl: credentialForm.baseUrl.trim(),
      apiKey: credentialForm.apiKey.trim(),
      modelNames,
      enabled: credentialForm.enabled,
    };

    setSavingSettings(true);
    try {
      if (credentialForm.credentialId) {
        const updateInput = {
          credentialId: credentialForm.credentialId,
          displayName: input.displayName,
          baseUrl: input.baseUrl,
          modelNames: input.modelNames,
          enabled: input.enabled,
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        };
        await updateCustomCredential(updateInput);
        pushToast('Custom credential updated.', 'success');
      } else {
        await createCustomCredential(input);
        pushToast('Custom credential added.', 'success');
      }

      setCredentialForm(EMPTY_CREDENTIAL_FORM);
      await refreshAgentSettings(false);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to save custom credential.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleToggleCredential(credential: AgentCustomCredential) {
    setSavingSettings(true);
    try {
      await updateCustomCredential({ credentialId: credential.id, enabled: !credential.enabled });
      await refreshAgentSettings(false);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to update credential.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleDeleteCredential(credential: AgentCustomCredential) {
    setSavingSettings(true);
    try {
      await deleteCustomCredential(credential.id);
      if (preferences.selectedCustomCredentialId === credential.id) {
        await persistPreferences({
          ...preferences,
          selectedCustomCredentialId: null,
          selectedCustomModelName: null,
          selectedSource: 'managed',
        });
      }
      await refreshAgentSettings(false);
      pushToast('Custom credential deleted.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to delete credential.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestCredential(credential: AgentCustomCredential) {
    setSavingSettings(true);
    try {
      await testCustomCredential(credential.id);
      pushToast('Provider accepted the custom credential.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Credential test failed.', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  useEffect(() => {
    void refreshAgentSettings();
  }, [refreshAgentSettings, user.$id]);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages, pendingApproval]);

  return (
    <>
      <section className="agent-panel">
        <div className="agent-panel-header">
          <div>
            <p className="eyebrow">Aider agent</p>
            <h2>Agent Manager</h2>
          </div>
          <div className="agent-panel-actions">
            <button className="ghost-button compact" type="button" onClick={() => void refreshAgentSettings()}>
              <RefreshCw size={14} />
              Refresh
            </button>
            <button
              className="ghost-button compact"
              type="button"
              onClick={() => {
                setMessages([INITIAL_MESSAGE]);
                setPendingApproval(null);
              }}
            >
              <Trash2 size={14} />
              Clear
            </button>
          </div>
        </div>

        <div className="agent-tabs">
          <button className={view === 'chat' ? 'active' : ''} type="button" onClick={() => setView('chat')}>
            <MessageSquare size={14} />
            Chat
          </button>
          <button className={view === 'settings' ? 'active' : ''} type="button" onClick={() => setView('settings')}>
            <Settings2 size={14} />
            Settings
          </button>
          <button className={view === 'usage' ? 'active' : ''} type="button" onClick={() => setView('usage')}>
            <Bot size={14} />
            Usage
          </button>
        </div>

        <div className="agent-status-strip">
          <span className="release-badge">
            <Bot size={14} />
            {preferences.selectedSource === 'managed'
              ? `${preferences.defaultMode === 'plan' ? 'Plan' : 'Fast'} ${preferences.defaultMode === 'plan' ? '2x' : '1x'}`
              : selectedModel || 'Custom model'}
          </span>
          <span className="release-badge">{workspacePath ? 'Workspace ready' : 'Open a workspace'}</span>
          <span className="release-badge">
            {formatCredits(settings.creditAccount.remainingCredits)} / {formatCredits(settings.creditAccount.monthlyAllowance)} credits
          </span>
          {busy ? (
            <span className="release-badge">
              <LoaderCircle size={14} className="spin" />
              Running
            </span>
          ) : null}
        </div>

        {!hasCloudAgent ? (
          <div className="inline-banner inline-banner-warning agent-inline-banner">
            Push the agent Appwrite tables and functions before using managed models, custom credentials, or usage tracking.
          </div>
        ) : null}

        {agentSetupMessage ? <div className="agent-setup-note">{agentSetupMessage}</div> : null}

        {view === 'chat' ? (
          <>
            <div className="agent-mode-grid">
              <div className="agent-mode-group">
                <p className="eyebrow">Model source</p>
                <div className="segmented-control">
                  <button
                    className={preferences.selectedSource === 'managed' ? 'active' : ''}
                    type="button"
                    disabled={loadingSettings}
                    onClick={() => void persistPreferences({ ...preferences, selectedSource: 'managed' })}
                  >
                    Managed
                  </button>
                  <button
                    className={preferences.selectedSource === 'custom' ? 'active' : ''}
                    type="button"
                    disabled={loadingSettings || enabledCustomCredentials.length === 0}
                    onClick={() =>
                      void persistPreferences({
                        ...preferences,
                        selectedSource: 'custom',
                        selectedCustomCredentialId: selectedCredential?.id ?? null,
                        selectedCustomModelName: selectedModel,
                      })
                    }
                  >
                    Custom
                  </button>
                </div>
              </div>

              {preferences.selectedSource === 'managed' ? (
                <div className="agent-mode-group">
                  <p className="eyebrow">Managed mode</p>
                  <div className="segmented-control">
                    <button
                      className={preferences.defaultMode === 'fast' ? 'active' : ''}
                      type="button"
                      onClick={() => void persistPreferences({ ...preferences, defaultMode: 'fast' })}
                    >
                      Fast 1x
                    </button>
                    <button
                      className={preferences.defaultMode === 'plan' ? 'active' : ''}
                      type="button"
                      onClick={() => void persistPreferences({ ...preferences, defaultMode: 'plan' })}
                    >
                      Plan 2x
                    </button>
                  </div>
                </div>
              ) : (
                <div className="agent-custom-picker">
                  <label>
                    Key
                    <select
                      value={selectedCredential?.id ?? ''}
                      onChange={(event) => {
                        const credential = settings.customCredentials.find((entry) => entry.id === event.target.value) ?? null;
                        void persistPreferences({
                          ...preferences,
                          selectedSource: 'custom',
                          selectedCustomCredentialId: credential?.id ?? null,
                          selectedCustomModelName: credential?.modelNames[0] ?? null,
                        });
                      }}
                    >
                      {enabledCustomCredentials.map((credential) => (
                        <option key={credential.id} value={credential.id}>
                          {credential.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Model
                    <select
                      value={selectedModel ?? ''}
                      onChange={(event) => void persistPreferences({ ...preferences, selectedCustomModelName: event.target.value })}
                    >
                      {(selectedCredential?.modelNames ?? []).map((modelName) => (
                        <option key={modelName} value={modelName}>
                          {modelName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>

            {preferences.selectedSource === 'managed' && !canUseManaged ? (
              <div className="inline-banner inline-banner-warning agent-inline-banner">
                Managed agent access is unavailable until a pool key is assigned and credits remain.
              </div>
            ) : null}

            <div ref={messageListRef} className="agent-message-list">
              {messages.map((message) => (
                <article key={message.id} className={`agent-message agent-message-${message.role} ${message.tone ? `agent-message-${message.tone}` : ''}`}>
                  <div className="agent-message-meta">
                    <span>{message.role === 'assistant' ? 'Aider' : message.role === 'user' ? 'You' : 'Status'}</span>
                  </div>
                  <div className="agent-message-body">
                    {message.role === 'assistant' ? <MarkdownRenderer content={message.content} /> : <pre>{message.content}</pre>}
                  </div>
                </article>
              ))}

              {pendingApproval?.preview.kind === 'agent-run' ? (
                <article className="agent-approval-card">
                  <div className="agent-approval-head">
                    <div>
                      <p className="eyebrow">Approval required</p>
                      <h3>{pendingApproval.summary}</h3>
                    </div>
                    <ShieldAlert size={18} />
                  </div>
                  <div className="agent-change-list">
                    {pendingApproval.preview.files.map((file) => (
                      <button key={file.path} type="button" onClick={() => setSelectedReviewPath(file.path)}>
                        <span>{file.changeType}</span>
                        <code>{file.path}</code>
                      </button>
                    ))}
                  </div>
                  <div className="action-row">
                    <button className="ghost-button compact" type="button" onClick={() => setReviewModalOpen(true)}>
                      <Play size={14} />
                      Review diff
                    </button>
                    <button className="danger-button compact" type="button" disabled={busy} onClick={() => void handleApproval(false)}>
                      <X size={14} />
                      Deny
                    </button>
                    <button className="primary-button compact" type="button" disabled={busy} onClick={() => void handleApproval(true)}>
                      <Check size={14} />
                      Apply
                    </button>
                  </div>
                </article>
              ) : null}
            </div>

            <div className="agent-composer">
              <textarea
                value={draftPrompt}
                disabled={!workspacePath || busy}
                onChange={(event) => setDraftPrompt(event.target.value)}
                placeholder={workspacePath ? 'Ask Aider to inspect, explain, or modify this workspace.' : 'Open a workspace to start the agent.'}
                rows={4}
              />
              <div className="agent-composer-actions">
                <span className="agent-composer-hint">
                  {pendingApproval ? 'Review the pending sandbox diff before continuing.' : 'Aider edits a sandbox first, then asks for approval.'}
                </span>
                <button className="primary-button" type="button" disabled={!canSend} onClick={() => void handleSendPrompt()}>
                  {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                  Send
                </button>
              </div>
            </div>
          </>
        ) : null}

        {view === 'settings' ? (
          <div className="agent-settings-view">
            <form className="agent-settings-card" onSubmit={(event) => void handleCredentialSubmit(event)}>
              <div className="agent-settings-grid">
                <label>
                  Display name
                  <input
                    value={credentialForm.displayName}
                    disabled={savingSettings}
                    onChange={(event) => setCredentialForm((current) => ({ ...current, displayName: event.target.value }))}
                    placeholder="OpenAI work key"
                  />
                </label>
                <label>
                  Base URL
                  <input
                    value={credentialForm.baseUrl}
                    disabled={savingSettings}
                    onChange={(event) => setCredentialForm((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={credentialForm.apiKey}
                    disabled={savingSettings}
                    onChange={(event) => setCredentialForm((current) => ({ ...current, apiKey: event.target.value }))}
                    placeholder={credentialForm.credentialId ? 'Leave blank to keep current key' : 'sk-...'}
                  />
                </label>
                <label>
                  Enabled
                  <select
                    value={credentialForm.enabled ? 'yes' : 'no'}
                    disabled={savingSettings}
                    onChange={(event) => setCredentialForm((current) => ({ ...current, enabled: event.target.value === 'yes' }))}
                  >
                    <option value="yes">Enabled</option>
                    <option value="no">Disabled</option>
                  </select>
                </label>
                <label className="agent-settings-span">
                  Model names
                  <textarea
                    value={credentialForm.modelNames}
                    disabled={savingSettings}
                    onChange={(event) => setCredentialForm((current) => ({ ...current, modelNames: event.target.value }))}
                    placeholder={'gpt-4.1\ngpt-4.1-mini'}
                    rows={3}
                  />
                </label>
              </div>
              <div className="form-actions">
                {credentialForm.credentialId ? (
                  <button className="ghost-button compact" type="button" onClick={() => setCredentialForm(EMPTY_CREDENTIAL_FORM)}>
                    <X size={14} />
                    Cancel
                  </button>
                ) : null}
                <button className="primary-button compact" type="submit" disabled={savingSettings}>
                  {savingSettings ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                  {credentialForm.credentialId ? 'Save changes' : 'Add key'}
                </button>
              </div>
            </form>

            <div className="agent-credential-list">
              {settings.customCredentials.length === 0 ? (
                <div className="agent-empty-state">
                  <KeyRound size={18} />
                  <span>No custom keys yet.</span>
                </div>
              ) : null}
              {settings.customCredentials.map((credential) => (
                <article key={credential.id} className="agent-credential-row">
                  <div>
                    <strong>{credential.displayName}</strong>
                    <span>
                      {credential.enabled ? 'Enabled' : 'Disabled'} · {credential.apiKeyPreview} · {credential.modelNames.join(', ')}
                    </span>
                    <code>{credential.baseUrl}</code>
                  </div>
                  <div className="action-row">
                    <button className="ghost-button compact" type="button" onClick={() => startEditingCredential(credential)}>
                      <Settings2 size={14} />
                      Edit
                    </button>
                    <button className="ghost-button compact" type="button" disabled={savingSettings} onClick={() => void handleTestCredential(credential)}>
                      <Play size={14} />
                      Test
                    </button>
                    <button className="ghost-button compact" type="button" disabled={savingSettings} onClick={() => void handleToggleCredential(credential)}>
                      {credential.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="danger-button compact" type="button" disabled={savingSettings} onClick={() => void handleDeleteCredential(credential)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {view === 'usage' ? (
          <div className="agent-usage-view">
            <div className="agent-usage-summary">
              <div>
                <span>Allowance</span>
                <strong>{formatCredits(settings.creditAccount.monthlyAllowance)}</strong>
              </div>
              <div>
                <span>Used</span>
                <strong>{formatCredits(settings.creditAccount.usedCredits)}</strong>
              </div>
              <div>
                <span>Remaining</span>
                <strong>{formatCredits(settings.creditAccount.remainingCredits)}</strong>
              </div>
              <div>
                <span>Resets</span>
                <strong>{formatDate(settings.creditAccount.resetAt)}</strong>
              </div>
            </div>

            <div className="agent-usage-list">
              {settings.recentUsage.length === 0 ? (
                <div className="agent-empty-state">
                  <Bot size={18} />
                  <span>No agent runs recorded yet.</span>
                </div>
              ) : null}
              {settings.recentUsage.map((event) => (
                <article key={event.id} className="agent-usage-row">
                  <div>
                    <strong>
                      {event.source === 'managed' ? (event.mode === 'plan' ? 'Plan' : 'Fast') : event.modelAlias || 'Custom'}
                    </strong>
                    <span>
                      {event.status} · {formatDate(event.createdAt)}
                    </span>
                    {event.errorMessage ? <code>{event.errorMessage}</code> : null}
                  </div>
                  <div>
                    <span>{event.totalTokens.toLocaleString()} tokens</span>
                    <strong>{event.chargedCredits.toLocaleString()} credits</strong>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <Modal
        open={reviewModalOpen && Boolean(selectedReviewFile)}
        title={selectedReviewFile ? `Review ${selectedReviewFile.path}` : 'Review agent changes'}
        subtitle="Sandbox diff before changes are applied to the real workspace."
        size="xl"
        onClose={() => setReviewModalOpen(false)}
      >
        {pendingApproval?.preview.kind === 'agent-run' && selectedReviewFile ? (
          <div className="agent-diff-review">
            <div className="agent-diff-meta">
              <select value={selectedReviewFile.path} onChange={(event) => setSelectedReviewPath(event.target.value)}>
                {pendingApproval.preview.files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.changeType}: {file.path}
                  </option>
                ))}
              </select>
              <span className="release-badge">{labelForChange(selectedReviewFile)}</span>
              {selectedReviewFile.stats ? <span className="release-badge">{selectedReviewFile.stats.changedLines} changed lines</span> : null}
            </div>
            <div className="agent-diff-shell">
              <DiffEditor
                height="100%"
                original={selectedReviewFile.originalContent}
                modified={selectedReviewFile.nextContent}
                language="cpp"
                theme="vs-dark"
                options={{
                  readOnly: true,
                  automaticLayout: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontFamily: 'var(--app-font-family)',
                  fontSize: 13,
                }}
              />
            </div>
            <div className="form-actions">
              <button className="danger-button compact" type="button" disabled={busy} onClick={() => void handleApproval(false)}>
                <X size={14} />
                Deny
              </button>
              <button className="primary-button compact" type="button" disabled={busy} onClick={() => void handleApproval(true)}>
                <Check size={14} />
                Apply changes
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function describeApprovalResolution(resolution: AgentApprovalResolution) {
  if (!resolution.success) {
    return `Agent change failed: ${resolution.error}`;
  }

  return resolution.output;
}

function labelForChange(file: AgentChangePreview) {
  switch (file.changeType) {
    case 'create':
      return 'New file';
    case 'delete':
      return 'Delete file';
    default:
      return 'Existing file';
  }
}
