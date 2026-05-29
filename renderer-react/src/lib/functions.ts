import { functions } from './appwrite';
import type { FunctionEnvelope } from './models';
import { safeJsonParse } from './utils';

type FunctionExecutionLike = Awaited<ReturnType<typeof functions.createExecution>> & {
  response?: string;
  statusCode?: number;
  stdout?: string;
  stderr?: string;
};

function executionResponseBody(execution: FunctionExecutionLike) {
  if (typeof execution.responseBody === 'string') {
    if (execution.responseBody.length > 0 || typeof execution.response !== 'string') {
      return execution.responseBody;
    }
  }

  if (typeof execution.response === 'string') {
    return execution.response;
  }

  return typeof execution.responseBody === 'string' ? execution.responseBody : '';
}

function executionResponseStatusCode(execution: FunctionExecutionLike) {
  const rawStatusCode = execution.responseStatusCode ?? execution.statusCode ?? 0;
  const statusCode = Number(rawStatusCode);
  return Number.isFinite(statusCode) ? statusCode : 0;
}

function cleanExecutionText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function executionDiagnostic(execution: FunctionExecutionLike) {
  return [
    cleanExecutionText(execution.errors),
    cleanExecutionText(execution.stderr),
    cleanExecutionText(execution.logs),
    cleanExecutionText(execution.stdout),
  ].find(Boolean);
}

export async function executeFunction<TInput extends object, TOutput>(
  functionId: string,
  body: TInput,
  pathName = '/',
) {
  const execution = await functions.createExecution(
    functionId,
    JSON.stringify(body),
    false,
    pathName,
    'POST',
    { 'content-type': 'application/json' },
  );

  const responseBody = executionResponseBody(execution);
  const fallbackError = executionDiagnostic(execution) || 'Function returned an empty response.';
  const parsed = safeJsonParse<FunctionEnvelope<TOutput>>(
    responseBody || JSON.stringify({ ok: false, error: fallbackError }),
    { ok: false, error: 'Function returned an unreadable response.' },
  );

  if (executionResponseStatusCode(execution) >= 400 || !parsed.ok || parsed.data === undefined || parsed.data === null) {
    throw new Error(parsed.error || responseBody || executionDiagnostic(execution) || 'Function execution failed.');
  }

  return parsed.data;
}
