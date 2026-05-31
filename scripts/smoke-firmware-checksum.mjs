#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sha256HexBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256HexText(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function prepareFirmwareUploadRecord({ binData, filename }) {
  const bytes = Buffer.from(binData, 'base64');
  return {
    file: {
      name: filename,
      bytes,
    },
    record: {
      filename,
      size: bytes.length,
      checksum: sha256HexBytes(bytes),
    },
  };
}

const firmwareBytes = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff, 0x41, 0x42]);
const base64Firmware = firmwareBytes.toString('base64');
const byteHash = sha256HexBytes(firmwareBytes);
const base64TextHash = sha256HexText(base64Firmware);

assert.equal(sha256HexBytes(Buffer.from(base64Firmware, 'base64')), byteHash);
assert.notEqual(base64TextHash, byteHash);

const upload = prepareFirmwareUploadRecord({
  binData: base64Firmware,
  filename: 'firmware.bin',
});

assert.equal(upload.record.checksum, byteHash);
assert.equal(upload.record.size, firmwareBytes.length);
assert.notEqual(upload.record.size, base64Firmware.length);
assert.deepEqual([...upload.file.bytes], [...firmwareBytes]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firmwareSource = fs.readFileSync(path.join(repoRoot, 'renderer-react/src/lib/firmware.ts'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(repoRoot, 'renderer-react/src/components/IDEWorkspace.tsx'), 'utf8');

assert.match(firmwareSource, /base64ToUint8Array\(payload\.compileResult\.binData\)/);
assert.match(firmwareSource, /const checksum = await sha256HexBytes\(firmwareBytes\)/);
assert.match(firmwareSource, /size:\s*firmwareSize/);
assert.doesNotMatch(firmwareSource, /payload\.checksum|checksum:\s*payload\.checksum/);
assert.doesNotMatch(workspaceSource, /sha256Hex\(compileResult\.binData\)/);

console.log('Firmware checksum smoke test passed.');
