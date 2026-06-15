#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { __testing } = require('../arduinoHandler.js');

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'appwrite.config.json'), 'utf8'));
const boardsTable = manifest.tables.find((table) => table.$id === 'boards');
assert.ok(boardsTable, 'boards table exists');
assert.ok(boardsTable.columns.some((column) => column.key === 'otaUpdateMode'), 'boards table stores otaUpdateMode');

const mqttRuntime = {
  boardId: 'bd_test',
  apiToken: 'token',
  appwriteEndpoint: 'https://api.example.com/v1',
  appwriteProjectId: 'tantalum',
  deviceGatewayFunctionId: 'device-gateway',
  firmwareVersion: '1.0.0',
  firmwareId: 'fw_test',
  commandSecret: 'command-secret',
  provisioningPop: 'pop',
  mqttHost: 'mqtt.example.com',
  mqttPort: 8883,
  mqttUsername: 'device',
  mqttPassword: 'password',
  mqttTopic: 'tantalum/boards/bd_test/suffix/cmd',
  mqttCaCert: '-----BEGIN CERTIFICATE-----\\nca\\n-----END CERTIFICATE-----',
};

const pollingSketch = __testing.buildCloudRuntimeSketch('void setup() {}\nvoid loop() {}', {
  ...mqttRuntime,
  otaUpdateMode: 'polling',
});
assert.match(pollingSketch, /#define TANTALUM_OTA_UPDATE_MODE "polling"/);
assert.match(pollingSketch, /#define TANTALUM_MQTT_REQUIRED 0/);
assert.doesNotMatch(pollingSketch, /#include <PubSubClient\.h>/);
assert.match(pollingSketch, /#define TANTALUM_MQTT_HOST ""/);
assert.equal(__testing.hasStrictMqttRuntimeConfig({ ...mqttRuntime, otaUpdateMode: 'polling' }), false);
assert.deepEqual(__testing.getCloudRuntimeRequiredLibraries({ ...mqttRuntime, otaUpdateMode: 'polling' }), ['ArduinoJson']);

const bothSketch = __testing.buildCloudRuntimeSketch('void setup() {}\nvoid loop() {}', {
  ...mqttRuntime,
  otaUpdateMode: 'both',
});
const bothMqttCaLine = bothSketch.split('\n').find((line) => line.includes('TANTALUM_MQTT_CA_CERT')) || '';
assert.match(bothSketch, /#define TANTALUM_OTA_UPDATE_MODE "both"/);
assert.match(bothSketch, /#define TANTALUM_MQTT_REQUIRED 1/);
assert.match(bothSketch, /#include <PubSubClient\.h>/);
assert.match(bothSketch, /#define TANTALUM_MQTT_HOST "mqtt\.example\.com"/);
assert.match(bothMqttCaLine, /\\nca\\n/);
assert.doesNotMatch(bothMqttCaLine, /\\\\nca\\\\n/);
assert.equal(__testing.hasStrictMqttRuntimeConfig({ ...mqttRuntime, otaUpdateMode: 'both' }), true);
assert.deepEqual(__testing.getCloudRuntimeRequiredLibraries({ ...mqttRuntime, otaUpdateMode: 'mqtt' }), ['ArduinoJson', 'PubSubClient']);
assert.deepEqual(__testing.getCloudRuntimeRequiredLibraries({ ...mqttRuntime, otaUpdateMode: 'both' }), ['ArduinoJson', 'PubSubClient']);

const runtimeSource = fs.readFileSync(path.join(repoRoot, 'resources/firmware/TantalumCloudRuntime.h'), 'utf8');
assert.match(runtimeSource, /TANTALUM_OTA_UPDATE_MODE/);
assert.match(runtimeSource, /TANTALUM_MQTT_REQUIRED && !TANTALUM_HAS_PUBSUBCLIENT/);
assert.match(runtimeSource, /pendingMqttCheckUpdate = true/);
assert.match(runtimeSource, /Ignored stale MQTT command/);
assert.match(runtimeSource, /Ignored replayed MQTT command/);
assert.match(runtimeSource, /pollingOtaEnabled\(\) && WiFi\.status\(\) == WL_CONNECTED/);

const boardAdminSource = fs.readFileSync(path.join(repoRoot, 'functions/board-admin/src/main.js'), 'utf8');
assert.match(boardAdminSource, /otaUpdateMode must be polling, mqtt, or both/);
assert.match(boardAdminSource, /skipped-polling-only/);
assert.match(boardAdminSource, /mqtt-failed-with-polling-fallback/);
assert.match(boardAdminSource, /mqtt-failed-no-fallback/);
assert.match(boardAdminSource, /boardUsesMqttOta\(board\)/);

const deviceGatewaySource = fs.readFileSync(path.join(repoRoot, 'functions/device-gateway/src/main.js'), 'utf8');
assert.match(deviceGatewaySource, /heartbeatCanOfferOta/);
assert.match(deviceGatewaySource, /allowOtaCommand: heartbeatCanOfferOta\(board\)/);

const boardsLibSource = fs.readFileSync(path.join(repoRoot, 'renderer-react/src/lib/boards.ts'), 'utf8');
assert.match(boardsLibSource, /'otaUpdateMode'/);
assert.match(boardsLibSource, /otaUpdateMode must be polling, mqtt, or both/);

console.log('OTA update mode smoke test passed.');
