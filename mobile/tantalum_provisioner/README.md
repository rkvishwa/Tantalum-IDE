# Tantalum Provisioner

Flutter companion app for Tantalum cloud boards.

## Runtime Configuration

Pass Appwrite IDs with `--dart-define`:

```bash
flutter run \
  --dart-define=APPWRITE_ENDPOINT=https://sgp.cloud.appwrite.io/v1 \
  --dart-define=APPWRITE_PROJECT_ID=697b8f42002a34ba04b3 \
  --dart-define=APPWRITE_DATABASE_ID=697b8f660033fffde4be \
  --dart-define=APPWRITE_BOARDS_COLLECTION_ID=boards \
  --dart-define=APPWRITE_BOARD_ADMIN_FUNCTION_ID=board-admin
```

## Native Provisioning Bridge

Dart calls `com.tantalum.ide/provisioning` through `lib/provisioning_bridge.dart`.

Native implementations must use Espressif's official provisioning libraries:

- Android: `com.espressif:provisioning`
- iOS: `ESPProvision`

The bridge methods are:

- `scanBle`
- `provisionBle`
- `provisionSoftAp`

The Dart app does not reimplement Espressif BLE or SoftAP provisioning protocol.
