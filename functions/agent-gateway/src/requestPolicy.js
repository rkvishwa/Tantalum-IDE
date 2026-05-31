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

export { createTemperatureRetryRequestBody, isDefaultOnlyTemperatureError };
