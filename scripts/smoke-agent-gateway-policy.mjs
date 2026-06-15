import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OUTPUT_STYLE_POLICIES,
  applyAgentOutputPolicy,
  normalizeAgentOutputStyle,
} from '../functions/agent-gateway/src/outputPolicy.js';
import {
  createMaxCompletionTokensRetryRequestBody,
  createTemperatureRetryRequestBody,
  isDefaultOnlyTemperatureError,
  isUnsupportedMaxTokensError,
} from '../functions/agent-gateway/src/requestPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function serialized(value) {
  return JSON.stringify(value);
}

function assertCompactPolicy(value) {
  const text = typeof value === 'string' ? value : serialized(value);
  assert.match(text, /concise, direct, normal English/);
  assert.match(text, /Do not mention hidden settings/);
}

function assertNoLegacyStyleLeak(value) {
  assert.doesNotMatch(serialized(value), /caveman/i);
}

function runChatCompletionsPolicySmoke() {
  const request = {
    model: 'openai/tantalum-fast',
    messages: [
      { role: 'system', content: 'Base system rule.' },
      { role: 'user', content: 'Explain blink sketch.' },
    ],
  };

  const shaped = applyAgentOutputPolicy(request, '/chat/completions', 'compact');
  assert.notEqual(shaped, request);
  assert.equal(shaped.messages.length, 2);
  assert.match(shaped.messages[0].content, /Base system rule/);
  assertCompactPolicy(shaped.messages[0].content);
  assertNoLegacyStyleLeak(shaped);
  assert.equal(request.messages[0].content, 'Base system rule.');
}

function runChatCompletionsMissingSystemSmoke() {
  const shaped = applyAgentOutputPolicy(
    {
      messages: [{ role: 'user', content: 'Explain blink sketch.' }],
    },
    '/chat/completions',
    'compact',
  );

  assert.equal(shaped.messages[0].role, 'system');
  assertCompactPolicy(shaped.messages[0].content);
  assertNoLegacyStyleLeak(shaped);
  assert.equal(shaped.messages[1].role, 'user');
}

function runResponsesPolicySmoke() {
  const shaped = applyAgentOutputPolicy(
    {
      instructions: 'Base instruction.',
      input: 'Explain blink sketch.',
    },
    '/responses',
    'compact',
  );

  assert.match(shaped.instructions, /Base instruction/);
  assertCompactPolicy(shaped.instructions);
  assertNoLegacyStyleLeak(shaped);
  assert.equal(shaped.input, 'Explain blink sketch.');
}

function runCompletionsPolicySmoke() {
  const shaped = applyAgentOutputPolicy(
    {
      prompt: 'Explain blink sketch.',
    },
    '/completions',
    'compact',
  );

  assert.match(shaped.prompt, /^Answer in concise, direct, normal English/);
  assert.match(shaped.prompt, /Explain blink sketch/);
  assertNoLegacyStyleLeak(shaped);

  const arrayPrompt = ['Explain blink sketch.'];
  const unchanged = applyAgentOutputPolicy({ prompt: arrayPrompt }, '/completions', 'compact');
  assert.equal(unchanged.prompt, arrayPrompt);
}

function runStyleNormalizationSmoke() {
  assert.equal(normalizeAgentOutputStyle('normal'), 'normal');
  assert.equal(normalizeAgentOutputStyle('compact'), 'compact');
  assert.equal(normalizeAgentOutputStyle('caveman'), 'compact');
  assert.equal(normalizeAgentOutputStyle('unknown'), 'compact');

  const normal = applyAgentOutputPolicy({ messages: [] }, '/chat/completions', 'normal');
  assert.match(normal.messages[0].content, /clear technical prose/);
  assertNoLegacyStyleLeak(normal);

  const legacyAlias = applyAgentOutputPolicy({ messages: [] }, '/chat/completions', 'caveman');
  assertCompactPolicy(legacyAlias);
  assertNoLegacyStyleLeak(legacyAlias);

  assertCompactPolicy(OUTPUT_STYLE_POLICIES.compact);
  assertNoLegacyStyleLeak(OUTPUT_STYLE_POLICIES);
}

function runTemperatureRetryPolicySmoke() {
  const unsupported = new Error("Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.");
  assert.equal(isDefaultOnlyTemperatureError(unsupported), true);
  assert.equal(isDefaultOnlyTemperatureError(new Error('Provider request failed.')), false);

  const original = {
    model: 'openai/tantalum-power',
    temperature: 0.2,
    messages: [{ role: 'user', content: 'Hello' }],
  };
  const retry = createTemperatureRetryRequestBody(original);
  assert.ok(retry);
  assert.equal(Object.prototype.hasOwnProperty.call(retry, 'temperature'), false);
  assert.equal(retry.model, original.model);
  assert.equal(original.temperature, 0.2);
  assert.equal(createTemperatureRetryRequestBody({ model: 'openai/tantalum-fast' }), null);
}

function runMaxCompletionTokensRetryPolicySmoke() {
  const unsupported = new Error("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  assert.equal(isUnsupportedMaxTokensError(unsupported), true);
  assert.equal(isUnsupportedMaxTokensError(new Error('Provider request failed.')), false);

  const original = {
    model: 'openai/tantalum-power',
    max_tokens: 2048,
    messages: [{ role: 'user', content: 'Hello' }],
  };
  const retry = createMaxCompletionTokensRetryRequestBody(original);
  assert.ok(retry);
  assert.equal(Object.prototype.hasOwnProperty.call(retry, 'max_tokens'), false);
  assert.equal(retry.max_completion_tokens, 2048);
  assert.equal(retry.model, original.model);
  assert.equal(original.max_tokens, 2048);

  const existing = createMaxCompletionTokensRetryRequestBody({
    model: 'openai/tantalum-power',
    max_tokens: 2048,
    max_completion_tokens: 1024,
  });
  assert.equal(existing.max_completion_tokens, 1024);
  assert.equal(Object.prototype.hasOwnProperty.call(existing, 'max_tokens'), false);
  assert.equal(createMaxCompletionTokensRetryRequestBody({ model: 'openai/tantalum-fast' }), null);
}

async function runPowerModeSourceSmoke() {
  const source = await fs.readFile(path.join(__dirname, '..', 'functions', 'agent-gateway', 'src', 'main.js'), 'utf8');
  assert.match(source, /value === 'power' \|\| value === 'plan' \? 'power' : 'fast'/);
  assert.match(source, /alias === 'tantalum-power-editor'/);
  assert.match(source, /mode === 'power' \? 'Power' : 'Fast'/);
  assert.match(source, /source === 'managed' && mode === 'power' \? 2 : 1/);
  assert.match(source, /useMaxCompletionTokens: mode === 'power'/);
  assert.match(source, /openai\/tantalum-power/);
}

runChatCompletionsPolicySmoke();
runChatCompletionsMissingSystemSmoke();
runResponsesPolicySmoke();
runCompletionsPolicySmoke();
runStyleNormalizationSmoke();
runTemperatureRetryPolicySmoke();
runMaxCompletionTokensRetryPolicySmoke();
await runPowerModeSourceSmoke();

console.log('agent gateway output policy smoke checks passed');
