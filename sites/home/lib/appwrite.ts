'use client';

import { Account, Client, Databases, Functions, ID, Permission, Query, Role } from 'appwrite';
import { config } from './config';

export const client = new Client()
  .setEndpoint(config.endpoint)
  .setProject(config.projectId);

export const account = new Account(client);
export const databases = new Databases(client);
export const functions = new Functions(client);

export async function currentUser() {
  try {
    return await account.get();
  } catch {
    return null;
  }
}

export { ID, Permission, Query, Role };
