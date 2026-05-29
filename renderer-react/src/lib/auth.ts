import type { Models } from 'appwrite';

import { account, ID } from './appwrite';
import { loadAgentSettings } from './agent';

export async function getCurrentUser() {
  try {
    return await account.get();
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string) {
  const accountService = account as unknown as AccountWithCompat;

  if (typeof accountService.createEmailPasswordSession === 'function') {
    await accountService.createEmailPasswordSession(email, password);
  } else {
    await accountService.createEmailSession(email, password);
  }

  const user = await account.get();
  if (!user) {
    throw new Error('Appwrite session was created, but the current user could not be loaded.');
  }

  return user;
}

export async function register(email: string, password: string, name: string) {
  await account.create(ID.unique(), email, password, name);
  const user = await signIn(email, password);
  try {
    await loadAgentSettings(null);
  } catch {
    // The Agent panel will retry bootstrap; account creation should not be rolled back.
  }
  return user;
}

export async function signOut() {
  await account.deleteSession('current');
}

type AccountWithCompat = {
  createEmailSession: (email: string, password: string) => Promise<Models.Session>;
  createEmailPasswordSession?: (email: string, password: string) => Promise<Models.Session>;
};
