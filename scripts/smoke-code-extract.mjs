import assert from 'node:assert/strict';

import {
  normalizeTaskTags,
  parseModelJson,
  supportsCodeExtract,
} from '../functions/code-extract/src/helpers.js';

assert.deepEqual(normalizeTaskTags(['code-extract', 'other']), ['code-extract', 'other']);
assert.deepEqual(normalizeTaskTags('code-extract, vision\nother'), ['code-extract', 'vision', 'other']);
assert.equal(supportsCodeExtract({ enabled: true, taskTags: [] }), true);
assert.equal(supportsCodeExtract({ enabled: true, taskTags: ['code-extract'] }), true);
assert.equal(supportsCodeExtract({ enabled: true, taskTags: ['board-detection'] }), false);

const parsed = parseModelJson(
  JSON.stringify({
    files: [
      { path: '../sketch/sketch.ino', content: 'void setup() {}\nvoid loop() {}\n' },
      { path: 'notes.txt', content: 'approximate' },
    ],
    confidence: 0.42,
    notes: 'best effort',
    limitations: 'binary reconstruction',
  }),
  'test-model',
);

assert.equal(parsed.model, 'test-model');
assert.equal(parsed.confidence, 0.42);
assert.deepEqual(parsed.files.map((file) => file.path), ['sketch/sketch.ino', 'notes.txt']);
assert.equal(parsed.notes, 'best effort');
assert.equal(parsed.limitations, 'binary reconstruction');

console.log('code-extract function smoke passed');
