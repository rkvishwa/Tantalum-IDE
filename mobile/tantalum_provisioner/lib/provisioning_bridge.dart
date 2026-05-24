import 'package:flutter/services.dart';

class ProvisioningBridge {
  static const MethodChannel _channel =
      MethodChannel('com.tantalum.ide/provisioning');

  Future<List<String>> scanBle({String prefix = 'Tantalum-'}) async {
    final result =
        await _channel.invokeListMethod<String>('scanBle', {'prefix': prefix});
    return result ?? const [];
  }

  Future<void> provisionBle({
    required String serviceName,
    required String pop,
    required String ssid,
    required String password,
  }) {
    return _channel.invokeMethod<void>('provisionBle', {
      'serviceName': serviceName,
      'pop': pop,
      'ssid': ssid,
      'password': password,
    });
  }

  Future<void> provisionSoftAp({
    required String serviceName,
    required String pop,
    required String ssid,
    required String password,
  }) {
    return _channel.invokeMethod<void>('provisionSoftAp', {
      'serviceName': serviceName,
      'pop': pop,
      'ssid': ssid,
      'password': password,
    });
  }
}
