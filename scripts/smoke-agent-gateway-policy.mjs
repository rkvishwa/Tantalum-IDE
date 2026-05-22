import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OUTPUT_STYLE_POLICIES,
  applyAgentOutputPolicy,
  normalizeAgentOutputStyle,
} from '../functions/agent-gateway/src/outputPolicy.js';

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

async function runPowerModeSourceSmoke() {
  const source = await fs.readFile(path.join(__dirname, '..', 'functions', 'agent-gateway', 'src', 'main.js'), 'utf8');
  assert.match(source, /value === 'power' \|\| value === 'plan' \? 'power' : 'fast'/);
  assert.match(source, /alias === 'tantalum-power-editor'/);
  assert.match(source, /mode === 'power' \? 'Power' : 'Fast'/);
  assert.match(source, /source === 'managed' && mode === 'power' \? 2 : 1/);
  assert.match(source, /openai\/tantalum-power/);
}

runChatCompletionsPolicySmoke();
runChatCompletionsMissingSystemSmoke();
runResponsesPolicySmoke();
runCompletionsPolicySmoke();
runStyleNormalizationSmoke();
await runPowerModeSourceSmoke();

console.log('agent gateway output policy smoke checks passed');
