'use client';

import type { Models } from 'appwrite';
import { functions } from './appwrite';

export type FunctionEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

type ExecutionLike = Models.Execution & {
  response?: string;
  responseBody?: string;
  responseStatusCode?: number;
  statusCode?: number;
};

function responseBody(execution: ExecutionLike) {
  if (typeof execution.responseBody === 'string' && execution.responseBody.length > 0) {
    return execution.responseBody;
  }

  if (typeof execution.response === 'string') {
    return execution.response;
  }

  return typeof execution.responseBody === 'string' ? execution.responseBody : '';
}

export async function executeFunction<T>(functionId: string, path: string, payload: Record<string, unknown> = {}) {
  const execution = await functions.createExecution(
    functionId,
    JSON.stringify(payload),
    false,
    path,
    'POST',
    { 'content-type': 'application/json' },
  ) as ExecutionLike;

  const body = responseBody(execution);
  const parsed = JSON.parse(body || '{"ok":false,"error":"Function returned an empty response."}') as FunctionEnvelope<T>;
  const statusCode = Number(execution.responseStatusCode ?? execution.statusCode ?? 0);
  if (statusCode >= 400 || !parsed.ok || parsed.data === undefined) {
    throw new Error(parsed.error || 'Function execution failed.');
  }

  return parsed.data;
}
