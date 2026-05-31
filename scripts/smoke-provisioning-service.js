const assert = require("node:assert/strict");

const provisioningService = require("../src/services/provisioningService");

const { withEsp32CloudRuntimeUploadOptions } = provisioningService._test || {};

assert.equal(typeof withEsp32CloudRuntimeUploadOptions, "function");

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32s3"),
  "esp32:esp32:esp32s3:CDCOnBoot=cdc,EraseFlash=all"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32c3"),
  "esp32:esp32:esp32c3:CDCOnBoot=cdc,EraseFlash=all"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32"),
  "esp32:esp32:esp32:EraseFlash=all"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32s3:FlashSize=8M"),
  "esp32:esp32:esp32s3:FlashSize=8M,CDCOnBoot=cdc,EraseFlash=all"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:esp32s3:FlashSize=8M,CDCOnBoot=default,EraseFlash=none"),
  "esp32:esp32:esp32s3:FlashSize=8M,CDCOnBoot=cdc,EraseFlash=all"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("esp32:esp32:vendor_esp32s3_board:FlashSize=16M"),
  "esp32:esp32:vendor_esp32s3_board:FlashSize=16M,CDCOnBoot=cdc,EraseFlash=all"
);

assert.equal(
  withEsp32CloudRuntimeUploadOptions("arduino:avr:uno"),
  "arduino:avr:uno"
);

console.log("Provisioning service smoke tests passed.");
