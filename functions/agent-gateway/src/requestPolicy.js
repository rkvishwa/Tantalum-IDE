function isDefaultOnlyTemperatureError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /temperature/i.test(message) && /(default\s*\(?1\)?|only\s+the\s+default|does\s+not\s+support|unsupported\s+value)/i.test(message);
}

function createTemperatureRetryRequestBody(requestBody) {
  if (!requestBody || typeof requestBody !== 'object' || !Object.prototype.hasOwnProperty.call(requestBody, 'temperature')) {
    return null;
  }

  const retryBody = { ...requestBody };
  delete retryBody.temperature;
  return retryBody;
}

function isUnsupportedMaxTokensError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /max_tokens/i.test(message) && /(unsupported|not supported|use ['"]?max_completion_tokens|instead)/i.test(message);
}

function createMaxCompletionTokensRetryRequestBody(requestBody) {
  if (!requestBody || typeof requestBody !== 'object' || !Object.prototype.hasOwnProperty.call(requestBody, 'max_tokens')) {
    return null;
  }

  const retryBody = { ...requestBody };
  if (!Object.prototype.hasOwnProperty.call(retryBody, 'max_completion_tokens')) {
    retryBody.max_completion_tokens = retryBody.max_tokens;
  }
  delete retryBody.max_tokens;
  return retryBody;
}

export {
  createMaxCompletionTokensRetryRequestBody,
  createTemperatureRetryRequestBody,
  isDefaultOnlyTemperatureError,
  isUnsupportedMaxTokensError,
};
