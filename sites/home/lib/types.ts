import type { Models } from 'appwrite';

export type User = Models.User<Models.Preferences>;

export type BoardDocument = Models.Document & {
  userId: string;
  name: string;
  boardType: string;
  firmwareVersion?: string;
  status?: string;
  otaStatus?: string;
  provisioningStatus?: string;
  lastSeen?: string | null;
  tokenPreview?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FirmwareDocument = Models.Document & {
  userId: string;
  boardId: string;
  version: string;
  filename: string;
  size: number;
  deployed: boolean;
  uploadedAt: string;
  notes?: string;
};

export type AgentSettingsState = {
  managedAvailable: boolean;
  creditAccount: {
    monthlyAllowance: number;
    usedCredits: number;
    remainingCredits: number;
    resetAt: string;
  };
  recentUsage: Array<{
    id: string;
    source: string;
    mode: string;
    status: string;
    totalTokens: number;
    chargedCredits: number;
    createdAt: string;
    errorMessage?: string | null;
  }>;
  recentThreads: Array<{
    id: string;
    title: string;
    status: string;
    messageCount: number;
    lastMessageAt: string;
  }>;
};

export type AdminDashboard = {
  totals: {
    users: number;
    boards: number;
    recentUsageEvents: number;
    chargedCredits: number;
  };
  recentUsers: AdminUser[];
  recentUsage: AdminUsage[];
  creditAccounts: AdminCredit[];
  settings: AdminSetting[];
};

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  status: boolean;
  labels: string[];
  emailVerification: boolean;
  registration: string | null;
  accessedAt: string | null;
};

export type AdminUsage = {
  id: string;
  userId: string;
  source: string;
  mode: string;
  status: string;
  providerLabel: string;
  modelAlias: string;
  totalTokens: number;
  chargedCredits: number;
  createdAt: string;
  errorMessage: string;
};

export type AdminCredit = {
  id: string;
  userId: string;
  periodKey: string;
  monthlyAllowance: number;
  usedCredits: number;
  resetAt: string;
  updatedAt: string;
};

export type AdminSetting = {
  id: string;
  key: string;
  value: string;
  description: string;
  updatedAt: string;
};
