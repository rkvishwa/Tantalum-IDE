const assert = require("node:assert/strict");

const provisioningService = require("../src/services/provisioningService");

const {
  physicalSerialPortKey,
  serialPortPathsMatch,
  validateWifiPassphrase,
  withEsp32CloudRuntimeUploadOptions,
} = provisioningService._test || {};

assert.equal(typeof withEsp32CloudRuntimeUploadOptions, "function");
assert.equal(typeof serialPortPathsMatch, "function");
assert.equal(typeof validateWifiPassphrase, "function");

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32s3"),
  "esp32:esp32:esp32s3:CDCOnBoot=cdc"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32c3"),
  "esp32:esp32:esp32c3:CDCOnBoot=cdc"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32"),
  "esp32:esp32:esp32"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32s3:FlashSize=8M"),
  "esp32:esp32:esp32s3:FlashSize=8M,CDCOnBoot=cdc"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32s3:FlashSize=8M,CDCOnBoot=default,EraseFlash=none"),
  "esp32:esp32:esp32s3:FlashSize=8M,CDCOnBoot=cdc"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:vendor_esp32s3_board:FlashSize=16M"),
  "esp32:esp32:vendor_esp32s3_board:FlashSize=16M,CDCOnBoot=cdc"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32:EraseFlash=all"),
  "esp32:esp32:esp32"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("arduino:avr:uno"),
  "arduino:avr:uno"
);

assert.equal(validateWifiPassphrase(""), null);
assert.equal(validateWifiPassphrase("12345678"), null);
assert.match(validateWifiPassphrase("short"), /8-63/);
assert.match(validateWifiPassphrase("a".repeat(64)), /8-63/);
assert.match(validateWifiPassphrase("validpass\n"), /printable ASCII/);

if (process.platform === "darwin") {
  assert.equal(physicalSerialPortKey("/dev/cu.usbmodem11101"), "/dev/serial.usbmodem11101");
  assert.equal(physicalSerialPortKey("/dev/tty.usbmodem11101"), "/dev/serial.usbmodem11101");
  assert.equal(serialPortPathsMatch("/dev/cu.usbmodem11101", "/dev/tty.usbmodem11101"), true);
} else {
  assert.equal(serialPortPathsMatch("COM7", "COM7"), true);
  assert.equal(serialPortPathsMatch("COM7", "COM8"), false);
}

console.log("Provisioning service smoke tests passed.");
