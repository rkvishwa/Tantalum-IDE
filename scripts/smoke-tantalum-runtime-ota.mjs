#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSource = fs.readFileSync(path.join(repoRoot, 'resources/firmware/TantalumCloudRuntime.h'), 'utf8');

const connectBlocks = [...runtimeSource.matchAll(/bool connectVerifiedAppwriteClient\([\s\S]*?return true;\s*\n  \}\n#endif/g)].map((match) => match[0]);
assert.equal(connectBlocks.length, 2, 'expected ESP32 and ESP8266 verified Appwrite connect helpers');

for (const block of connectBlocks) {
  assert.doesNotMatch(block, /tcpProbe\.connect|TCP probe failed/, 'verified TLS connection must not be gated by a plain TCP probe');
  assert.match(block, /opening verified TLS to/);
  assert.match(block, /client\.connect\(url\.host\.c_str\(\), url\.port\)/);
}

assert.match(runtimeSource, /void printGatewayDiagnostics\([\s\S]*?TCP 443 reachable/);
assert.match(runtimeSource, /if \(targetVersion != nullptr && strlen\(targetVersion\) > 0\) \{[\s\S]*?Target OTA version/);
assert.doesNotMatch(runtimeSource, /Target OTA version:[\s\S]{0,160}"none"/);
assert.match(runtimeSource, /pendingStatus = "failed";[\s\S]*?OTA success did not boot expected firmware/);
assert.doesNotMatch(runtimeSource, /pendingStatus == "success" && pendingVersion != TANTALUM_FIRMWARE_VERSION\)\s*\{\s*return false;/);

console.log('Tantalum runtime OTA smoke test passed.');
