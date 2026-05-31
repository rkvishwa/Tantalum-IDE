#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <time.h>

#if __has_include(<PubSubClient.h>)
#include <PubSubClient.h>
#define TANTALUM_HAS_PUBSUBCLIENT 1
#else
#define TANTALUM_HAS_PUBSUBCLIENT 0
#endif

#if defined(ESP32)
#include <Preferences.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#if __has_include(<esp32-hal-rgb-led.h>)
#include <esp32-hal-rgb-led.h>
#define TANTALUM_HAS_ESP32_RGB_LED 1
#else
#define TANTALUM_HAS_ESP32_RGB_LED 0
#endif
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#if __has_include(<WiFiProv.h>)
#include <WiFiProv.h>
#define TANTALUM_HAS_ESP_WIFI_PROV 1
#else
#define TANTALUM_HAS_ESP_WIFI_PROV 0
#endif
#elif defined(ESP8266)
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <Updater.h>
#include <bearssl/bearssl.h>
#include <WiFiClientSecureBearSSL.h>
#else
#error "Tantalum cloud runtime currently supports ESP32 and ESP8266 boards only."
#endif

#ifndef TANTALUM_BOARD_ID
#define TANTALUM_BOARD_ID ""
#endif

#ifndef TANTALUM_API_TOKEN
#define TANTALUM_API_TOKEN ""
#endif

#ifndef TANTALUM_APPWRITE_ENDPOINT
#define TANTALUM_APPWRITE_ENDPOINT ""
#endif

#ifndef TANTALUM_APPWRITE_PROJECT_ID
#define TANTALUM_APPWRITE_PROJECT_ID ""
#endif

#ifndef TANTALUM_DEVICE_GATEWAY_FUNCTION_ID
#define TANTALUM_DEVICE_GATEWAY_FUNCTION_ID ""
#endif

#ifndef TANTALUM_FIRMWARE_VERSION
#define TANTALUM_FIRMWARE_VERSION "1.0.0"
#endif

#ifndef TANTALUM_FIRMWARE_ID
#define TANTALUM_FIRMWARE_ID ""
#endif

#ifndef TANTALUM_RUNTIME_VERSION
#define TANTALUM_RUNTIME_VERSION "1.1.5"
#endif

#ifndef TANTALUM_BUILD_EPOCH
#define TANTALUM_BUILD_EPOCH 1700000000UL
#endif

#ifndef TANTALUM_MQTT_HOST
#define TANTALUM_MQTT_HOST ""
#endif

#ifndef TANTALUM_MQTT_PORT
#define TANTALUM_MQTT_PORT 8883
#endif

#ifndef TANTALUM_MQTT_USERNAME
#define TANTALUM_MQTT_USERNAME ""
#endif

#ifndef TANTALUM_MQTT_PASSWORD
#define TANTALUM_MQTT_PASSWORD ""
#endif

#ifndef TANTALUM_MQTT_TOPIC
#define TANTALUM_MQTT_TOPIC ""
#endif

#ifndef TANTALUM_COMMAND_SECRET
#define TANTALUM_COMMAND_SECRET ""
#endif

#ifndef TANTALUM_TLS_CA_CERT
#define TANTALUM_TLS_CA_CERT ""
#endif

#ifndef TANTALUM_MQTT_CA_CERT
#define TANTALUM_MQTT_CA_CERT ""
#endif

#ifndef TANTALUM_PROVISIONING_POP
#define TANTALUM_PROVISIONING_POP ""
#endif

#ifndef TANTALUM_PROVISIONING_SERVICE_NAME
#define TANTALUM_PROVISIONING_SERVICE_NAME "Tantalum-Setup"
#endif

#ifndef TANTALUM_WIFI_HOSTNAME
#define TANTALUM_WIFI_HOSTNAME "tantalum-board"
#endif

static const unsigned long TANTALUM_DEFAULT_UPDATE_CHECK_MS = 5UL * 60UL * 1000UL;
static const unsigned long TANTALUM_HEARTBEAT_MS = 60UL * 1000UL;
static const unsigned long TANTALUM_WIFI_CONNECT_TIMEOUT_MS = 20000UL;
static const unsigned long TANTALUM_MQTT_RETRY_MS = 15000UL;
static const unsigned long TANTALUM_PROVISIONING_WINDOW_MS = 10UL * 60UL * 1000UL;
static const unsigned long TANTALUM_HTTP_TIMEOUT_MS = 20000UL;
static const unsigned long TANTALUM_GATEWAY_DIAGNOSTIC_MS = 5UL * 60UL * 1000UL;
static const unsigned long TANTALUM_TLS_MIN_EPOCH = (TANTALUM_BUILD_EPOCH > 1700000000UL) ? TANTALUM_BUILD_EPOCH : 1700000000UL;
static const unsigned long TANTALUM_OTA_RESULT_RETRY_MS = 60UL * 1000UL;
static const unsigned long TANTALUM_FAILED_DEPLOYMENT_RETRY_MS = 30UL * 60UL * 1000UL;
static const uint8_t TANTALUM_GATEWAY_ATTEMPTS = 3;
static const size_t TANTALUM_HTTP_BODY_MAX_BYTES = 16384;
static const size_t TANTALUM_OTA_CHUNK_BYTES = 1024;
#if defined(ESP32)
static const unsigned long TANTALUM_BACKGROUND_TASK_INTERVAL_MS = 500UL;
static const uint32_t TANTALUM_BACKGROUND_TASK_STACK = 12288;
#endif

// Appwrite Cloud currently chains through Starfield G2 and may also use Certainly R1.
static const char TANTALUM_APPWRITE_CLOUD_ROOT_CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIID3TCCAsWgAwIBAgIBADANBgkqhkiG9w0BAQsFADCBjzELMAkGA1UEBhMCVVMx
EDAOBgNVBAgTB0FyaXpvbmExEzARBgNVBAcTClNjb3R0c2RhbGUxJTAjBgNVBAoT
HFN0YXJmaWVsZCBUZWNobm9sb2dpZXMsIEluYy4xMjAwBgNVBAMTKVN0YXJmaWVs
ZCBSb290IENlcnRpZmljYXRlIEF1dGhvcml0eSAtIEcyMB4XDTA5MDkwMTAwMDAw
MFoXDTM3MTIzMTIzNTk1OVowgY8xCzAJBgNVBAYTAlVTMRAwDgYDVQQIEwdBcml6
b25hMRMwEQYDVQQHEwpTY290dHNkYWxlMSUwIwYDVQQKExxTdGFyZmllbGQgVGVj
aG5vbG9naWVzLCBJbmMuMTIwMAYDVQQDEylTdGFyZmllbGQgUm9vdCBDZXJ0aWZp
Y2F0ZSBBdXRob3JpdHkgLSBHMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAL3twQP89o/8ArFvW59I2Z154qK3A2FWGMNHttfKPTUuiUP3oWmb3ooa/RMg
nLRJdzIpVv257IzdIvpy3Cdhl+72WoTsbhm5iSzchFvVdPtrX8WJpRBSiUZV9Lh1
HOZ/5FSuS/hVclcCGfgXcVnrHigHdMWdSL5stPSksPNkN3mSwOxGXn/hbVNMYq/N
Hwtjuzqd+/x5AJhhdM8mgkBj87JyahkNmcrUDnXMN/uLicFZ8WJ/X7NfZTD4p7dN
dloedl40wOiWVpmKs/B/pM293DIxfJHP4F8R+GuqSVzRmZTRouNjWwl2tVZi4Ut0
HZbUJtQIBFnQmA4O5t78w+wfkPECAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAO
BgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFHwMMh+n2TB/xH1oo2Kooc6rB1snMA0G
CSqGSIb3DQEBCwUAA4IBAQARWfolTwNvlJk7mh+ChTnUdgWUXuEok21iXQnCoKjU
sHU48TRqneSfioYmUeYs0cYtbpUgSpIB7LiKZ3sx4mcujJUDJi5DnUox9g61DLu3
4jd/IroAow57UvtruzvE03lRTs2Q9GcHGcg8RnoNAX3FWOdt5oUwF5okxBDgBPfg
8n/Uqgr/Qh037ZTlZFkSIHc40zI+OIF1lnP6aI+xy84fxez6nH7PfrHxBy22/L/K
pL/QlwVKvOoYKAKQvVR4CSFx09F9HdkWsKlhPdAKACL8x3vLCWRFCztAgfd9fDL1
mMpYjn0q7pBZc2T5NnReJaH1ZgUufzkVqSr7UIuOhWn0
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFRzCCAy+gAwIBAgIRAI4P+UuQcWhlM1T01EQ5t+AwDQYJKoZIhvcNAQELBQAw
PTELMAkGA1UEBhMCVVMxEjAQBgNVBAoTCUNlcnRhaW5seTEaMBgGA1UEAxMRQ2Vy
dGFpbmx5IFJvb3QgUjEwHhcNMjEwNDAxMDAwMDAwWhcNNDYwNDAxMDAwMDAwWjA9
MQswCQYDVQQGEwJVUzESMBAGA1UEChMJQ2VydGFpbmx5MRowGAYDVQQDExFDZXJ0
YWlubHkgUm9vdCBSMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANA2
1B/q3avk0bbm+yLA3RMNansiExyXPGhjZjKcA7WNpIGD2ngwEc/csiu+kr+O5MQT
vqRoTNoCaBZ0vrLdBORrKt03H2As2/X3oXyVtwxwhi7xOu9S98zTm/mLvg7fMbed
aFySpvXl8wo0tf97ouSHocavFwDvA5HtqRxOcT3Si2yJ9HiG5mpJoM610rCrm/b0
1C7jcvk2xusVtyWMOvwlDbMicyF0yEqWYZL1LwsYpfSt4u5BvQF5+paMjRcCMLT5
r3gajLQ2EBAHBXDQ9DGQilHFhiZ5shGIXsXwClTNSaa/ApzSRKft43jvRl5tcdF5
cBxGX1HpyTfcX35pe0HfNEXgO4T0oYoKNp43zGJS4YkNKPl6I7ENPT2a/Z2B7yyQ
wHtETrtJ4A5KVpK8y7XdeReJkd5hiXSSqOMyhb5OhaRLWcsrxXiOcVTQAjeZjOVJ
6uBUcqQRBi8LjMFbvrWhsFNunLhgkR9Za/kt9JQKl7XsxXYDVBtlUrpMklZRNaBA
2CnbrlJ2Oy0wQJuK0EJWtLeIAaSHO1OWzaMWj/Nmqhexx2DgwUMFDO6bW2BvBlyH
Wyf5QBGenDPBt+U1VwV/J84XIIwc/PH72jEpSe31C4SnT8H2TsIonPru4K8H+zMR
eiFPCyEQtkA6qyI6BJyLm4SGcprSp6XEtHWRqSsjAgMBAAGjQjBAMA4GA1UdDwEB
/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTgqj8ljZ9EXME66C6u
d0yEPmcM9DANBgkqhkiG9w0BAQsFAAOCAgEAuVevuBLaV4OPaAszHQNTVfSVcOQr
PbA56/qJYv331hgELyE03fFo8NWWWt7CgKPBjcZq91l3rhVkz1t5BXdm6ozTaw3d
8VkswTOlMIAVRQdFGjEitpIAq5lNOo93r6kiyi9jyhXWx8bwPWz8HA2YEGGeEaIi
1wrykXprOQ4vMMM2SZ/g6Q8CRFA3lFV96p/2O7qUpUzpvD5RtOjKkjZUbVwlKNrd
rRT90+7iIgXr0PK3aBLXWopBGsaSpVo7Y0VPv+E6dyIvXL9G+VoDhRNCX8reU9di
taY1BMJH/5n9hN9czulegChB8n3nHpDYT3Y+gjwN/KUD+nsa2UUeYNrEjvn8K8l7
lcUq/6qJ34IxD3L/DCfXCh5WAFAeDJDBlrXYFIW7pw0WwfgHJBu6haEaBQmAupVj
yTrsJZ9/nbqkRxWbRHDxakvWOF5D8xh+UG7pWijmZeZ3Gzr9Hb4DJqPb1OG7fpYn
Kx3upPvaJVQTA945xsMfTZDsjxtK0hzthZU4UHlG1sGQUDGpXJpuHfUzVounmdLy
yCwzk5Iwx06MZTMQZBf9JBeW0Y3COmor6xOLRPIh80oat3df1+2IpHLlOR+Vnb5n
wXARPbv0+Em34yaXOp/SX3z7wJl8OSngex2/DaeP0ik0biQVy96QXr8axGbqwua6
OV+KmalBWQewLK8=
-----END CERTIFICATE-----
)EOF";

// Common public root for Let's Encrypt-backed self-hosted Appwrite endpoints.
static const char TANTALUM_PUBLIC_ISRG_ROOT_X1_CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

#if defined(ESP32)
static volatile int tantalumLastWifiDisconnectReason = 0;
#endif

#if defined(ESP8266)
static ESP8266WebServer tantalumProvisioningServer(80);
static String tantalumPendingSsid;
static String tantalumPendingPassword;
#endif

class TantalumCloudRuntimeClass {
public:
  void begin() {
    Serial.begin(115200);
    delay(200);
    Serial.println();
    Serial.println("Tantalum cloud runtime starting.");
    Serial.print("Board ID: ");
    Serial.println(TANTALUM_BOARD_ID);
    Serial.print("Firmware version: ");
    Serial.println(TANTALUM_FIRMWARE_VERSION);
    Serial.print("Runtime version: ");
    Serial.println(TANTALUM_RUNTIME_VERSION);
    Serial.print("Runtime build epoch: ");
    Serial.println(TANTALUM_BUILD_EPOCH);
    Serial.print("Appwrite endpoint: ");
    Serial.println(TANTALUM_APPWRITE_ENDPOINT);
    Serial.print("Device gateway: ");
    Serial.println(TANTALUM_DEVICE_GATEWAY_FUNCTION_ID);
    clearOnboardRgbLed();
    showBootstrapInstallMarker();

#if defined(ESP32)
    preferences.begin("tantalum", false);
    serviceMutex = xSemaphoreCreateMutex();
#endif

    configureSecureClients();
    configureWifiDiagnostics();
    connectToWiFi();
    printRuntimeStatus("boot");
    reportPendingOtaResult(true);
    sendHeartbeat();
    checkForUpdates();

#if defined(ESP32)
    startBackgroundTask();
#endif
  }

  void loop() {
    serviceLoop();
  }

  void openProvisioningWindow(const char* reason = "manual") {
#if defined(ESP32)
    if (serviceMutex != nullptr && xSemaphoreTake(serviceMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
      startProvisioning(reason);
      xSemaphoreGive(serviceMutex);
      return;
    }

    if (serviceMutex == nullptr) {
      startProvisioning(reason);
    }
#else
    startProvisioning(reason);
#endif
  }

private:
  void setOnboardRgbPower(bool enabled) {
#if defined(ESP32) && defined(NEOPIXEL_POWER)
    pinMode(NEOPIXEL_POWER, OUTPUT);
    if (enabled) {
#if defined(NEOPIXEL_POWER_ON)
      digitalWrite(NEOPIXEL_POWER, NEOPIXEL_POWER_ON);
#else
      digitalWrite(NEOPIXEL_POWER, HIGH);
#endif
      delay(2);
      return;
    }

#if defined(NEOPIXEL_POWER_ON)
    digitalWrite(NEOPIXEL_POWER, NEOPIXEL_POWER_ON == HIGH ? LOW : HIGH);
#else
    digitalWrite(NEOPIXEL_POWER, LOW);
#endif
#else
    (void)enabled;
#endif
  }

  void writeOnboardRgbLed(uint8_t red, uint8_t green, uint8_t blue) {
#if defined(ESP32)
    setOnboardRgbPower(true);
#if TANTALUM_HAS_ESP32_RGB_LED && defined(PIN_NEOPIXEL)
    neopixelWrite(PIN_NEOPIXEL, red, green, blue);
    delay(2);
    rgbLedWrite(PIN_NEOPIXEL, red, green, blue);
    delay(2);
#endif

#if TANTALUM_HAS_ESP32_RGB_LED && defined(RGB_BUILTIN)
    rgbLedWrite(RGB_BUILTIN, red, green, blue);
    delay(2);
#endif
#else
    (void)red;
    (void)green;
    (void)blue;
#endif
  }

  void clearOnboardRgbLed() {
#if defined(ESP32)
    writeOnboardRgbLed(0, 0, 0);

#if defined(LED_BUILTIN) && (!defined(RGB_BUILTIN) || LED_BUILTIN != RGB_BUILTIN)
    pinMode(LED_BUILTIN, OUTPUT);
    digitalWrite(LED_BUILTIN, LOW);
#endif
#endif
  }

  void showBootstrapInstallMarker() {
#if defined(ESP32) && defined(TANTALUM_BOOTSTRAP_BUILD) && TANTALUM_BOOTSTRAP_BUILD
    Serial.println("Tantalum bootstrap marker active.");
    for (uint8_t index = 0; index < 3; index++) {
      writeOnboardRgbLed(0, 32, 0);
      delay(140);
      writeOnboardRgbLed(0, 0, 0);
      delay(140);
    }
    // The install-only bootstrap should leave any onboard NeoPixel dark.
    setOnboardRgbPower(false);
#endif
  }

  void serviceLoop() {
#if defined(ESP32)
    if (serviceMutex != nullptr) {
      if (xSemaphoreTake(serviceMutex, 0) != pdTRUE) {
        return;
      }
      serviceLoopUnlocked();
      xSemaphoreGive(serviceMutex);
      return;
    }
#endif

    serviceLoopUnlocked();
  }

  void serviceLoopUnlocked() {
    handleSerialProvisioning();

#if defined(ESP8266)
    if (provisioningActive) {
      tantalumProvisioningServer.handleClient();
    }
#endif

    if (WiFi.status() != WL_CONNECTED && !provisioningActive) {
      connectToWiFi();
    }

    if (WiFi.status() == WL_CONNECTED) {
      maintainMqtt();
      reportPendingOtaResult(false);
    }

#if TANTALUM_HAS_PUBSUBCLIENT
    if (mqttClient.connected()) {
      mqttClient.loop();
    }
#endif

    unsigned long now = millis();

    if (provisioningActive && now - provisioningStartedAt > TANTALUM_PROVISIONING_WINDOW_MS) {
      provisioningActive = false;
#if defined(ESP8266)
      tantalumProvisioningServer.stop();
      WiFi.softAPdisconnect(true);
#endif
      WiFi.mode(WIFI_STA);
      connectToWiFi();
    }

    if (WiFi.status() == WL_CONNECTED && now - lastHeartbeatAt >= TANTALUM_HEARTBEAT_MS) {
      lastHeartbeatAt = now;
      sendHeartbeat();
    }

    if (WiFi.status() == WL_CONNECTED && now - lastUpdateCheckAt >= updateCheckIntervalMs) {
      lastUpdateCheckAt = now;
      checkForUpdates();
    }
  }
#if defined(ESP32)
  WiFiClientSecure httpClient;
  WiFiClientSecure mqttSecureClient;
  Preferences preferences;
  SemaphoreHandle_t serviceMutex = nullptr;
  TaskHandle_t backgroundTaskHandle = nullptr;
#elif defined(ESP8266)
  BearSSL::WiFiClientSecure httpClient;
  BearSSL::WiFiClientSecure mqttSecureClient;
  BearSSL::X509List appwriteCloudTrustAnchor{TANTALUM_APPWRITE_CLOUD_ROOT_CA_CERT};
  BearSSL::X509List appwriteCustomTrustAnchor{(sizeof(TANTALUM_TLS_CA_CERT) > 1) ? TANTALUM_TLS_CA_CERT : TANTALUM_PUBLIC_ISRG_ROOT_X1_CA_CERT};
  BearSSL::X509List mqttTrustAnchor{TANTALUM_MQTT_CA_CERT};
#endif
#if TANTALUM_HAS_PUBSUBCLIENT
  PubSubClient mqttClient{mqttSecureClient};
#endif
  unsigned long lastHeartbeatAt = 0;
  unsigned long lastUpdateCheckAt = 0;
  unsigned long lastMqttAttemptAt = 0;
  unsigned long lastGatewayDiagnosticAt = 0;
  unsigned long lastPendingOtaResultAt = 0;
  unsigned long lastFailedOtaAt = 0;
  unsigned long lastFailedOtaSkipLogAt = 0;
  unsigned long updateCheckIntervalMs = TANTALUM_DEFAULT_UPDATE_CHECK_MS;
  unsigned long provisioningStartedAt = 0;
  bool provisioningActive = false;
  bool otaInProgress = false;
  bool mqttConfigWarningLogged = false;
  bool tlsClockAttempted = false;
  bool tlsClockReady = false;
  bool tlsClockWarningLogged = false;
  bool appwriteCaWarningLogged = false;
  String serialLineBuffer;
  String pendingOtaDeploymentRam;
  String pendingOtaFirmwareRam;
  String pendingOtaVersionRam;
  String pendingOtaStatusRam;
  String pendingOtaErrorRam;
  String failedOtaDeploymentRam;

#if defined(ESP32)
  static void backgroundTaskEntry(void* parameter) {
    static_cast<TantalumCloudRuntimeClass*>(parameter)->backgroundTaskLoop();
  }

  void startBackgroundTask() {
    if (backgroundTaskHandle != nullptr) {
      return;
    }

    BaseType_t created = xTaskCreate(
      backgroundTaskEntry,
      "tantalum-cloud",
      TANTALUM_BACKGROUND_TASK_STACK,
      this,
      1,
      &backgroundTaskHandle
    );

    if (created != pdPASS) {
      backgroundTaskHandle = nullptr;
      Serial.println("Failed to start Tantalum background service.");
      return;
    }

    Serial.println("Tantalum background service started.");
  }

  void backgroundTaskLoop() {
    delay(1000);
    for (;;) {
      serviceLoop();
      vTaskDelay(pdMS_TO_TICKS(TANTALUM_BACKGROUND_TASK_INTERVAL_MS));
    }
  }
#endif

  String normalizedAppwriteEndpoint() {
    String endpoint = String(TANTALUM_APPWRITE_ENDPOINT);
    endpoint.trim();
    while (endpoint.endsWith("/")) {
      endpoint.remove(endpoint.length() - 1);
    }
    return endpoint;
  }

  String extractHostFromUrl(const String& url) {
    int hostStart = url.indexOf("://");
    hostStart = hostStart >= 0 ? hostStart + 3 : 0;
    int hostEnd = url.indexOf('/', hostStart);
    String host = hostEnd >= 0 ? url.substring(hostStart, hostEnd) : url.substring(hostStart);
    int portIndex = host.indexOf(':');
    if (portIndex >= 0) {
      host = host.substring(0, portIndex);
    }
    host.trim();
    return host;
  }

  bool isAppwriteCloudEndpoint() {
    String host = extractHostFromUrl(normalizedAppwriteEndpoint());
    host.toLowerCase();
    return host == "cloud.appwrite.io" || host.endsWith(".cloud.appwrite.io");
  }

  const char* appwriteCaCertificate() {
    if (isAppwriteCloudEndpoint()) {
      return TANTALUM_APPWRITE_CLOUD_ROOT_CA_CERT;
    }

    if (strlen(TANTALUM_TLS_CA_CERT) > 0) {
      return TANTALUM_TLS_CA_CERT;
    }

    return TANTALUM_PUBLIC_ISRG_ROOT_X1_CA_CERT;
  }

  const char* appwriteCaSource() {
    if (isAppwriteCloudEndpoint()) {
      return "Appwrite Cloud built-in CA bundle";
    }

    if (strlen(TANTALUM_TLS_CA_CERT) > 0) {
      return "custom TANTALUM_TLS_CA_CERT";
    }

    return "public ISRG Root X1 fallback";
  }

  bool ensureTlsClockReady() {
    if (tlsClockReady) {
      return true;
    }

    if (!tlsClockAttempted) {
      tlsClockAttempted = true;
      Serial.println("Synchronizing clock for TLS.");
      configTime(0, 0, "pool.ntp.org", "time.nist.gov", "time.google.com");
    }

    unsigned long startedAt = millis();
    while (static_cast<unsigned long>(time(nullptr)) < TANTALUM_TLS_MIN_EPOCH && millis() - startedAt < 7000UL) {
      delay(250);
    }

    unsigned long currentEpoch = static_cast<unsigned long>(time(nullptr));
    tlsClockReady = currentEpoch >= TANTALUM_TLS_MIN_EPOCH;
    if (!tlsClockReady && !tlsClockWarningLogged) {
      Serial.println("TLS clock sync did not complete; refusing Appwrite HTTPS because certificate verification would be unsafe.");
      Serial.print("  Current TLS epoch: ");
      Serial.println(currentEpoch);
      Serial.print("  Required minimum epoch: ");
      Serial.println(TANTALUM_TLS_MIN_EPOCH);
      tlsClockWarningLogged = true;
    }
    return tlsClockReady;
  }

  bool appwriteCaReady() {
    const char* caCert = appwriteCaCertificate();
    if (strlen(caCert) > 0) {
      return true;
    }

    if (!appwriteCaWarningLogged) {
      Serial.println("Appwrite TLS CA is not configured; refusing HTTPS request.");
      appwriteCaWarningLogged = true;
    }
    return false;
  }

#if defined(ESP32)
  bool configureAppwriteSecureClient(WiFiClientSecure& client) {
    if (!appwriteCaReady() || !ensureTlsClockReady()) {
      return false;
    }

    client.stop();
    client.setTimeout(TANTALUM_HTTP_TIMEOUT_MS);
    client.setCACert(appwriteCaCertificate());
    return true;
  }
#elif defined(ESP8266)
  bool configureAppwriteSecureClient(BearSSL::WiFiClientSecure& client) {
    if (!appwriteCaReady() || !ensureTlsClockReady()) {
      return false;
    }

    client.stop();
    client.setTrustAnchors(isAppwriteCloudEndpoint() ? &appwriteCloudTrustAnchor : &appwriteCustomTrustAnchor);
    client.setX509Time(time(nullptr));
    return true;
  }
#endif

  void printRuntimeStatus(const char* operation, const char* targetVersion = "") {
    Serial.print("Tantalum runtime status [");
    Serial.print(operation);
    Serial.println("]");
    Serial.print("  Runtime version: ");
    Serial.println(TANTALUM_RUNTIME_VERSION);
    Serial.print("  Appwrite endpoint: ");
    Serial.println(normalizedAppwriteEndpoint());
    Serial.print("  CA source: ");
    Serial.println(appwriteCaSource());
    Serial.print("  TLS epoch: ");
    Serial.println(static_cast<unsigned long>(time(nullptr)));
    Serial.print("  TLS minimum epoch: ");
    Serial.println(TANTALUM_TLS_MIN_EPOCH);
    Serial.print("  Free sketch space: ");
    Serial.println(ESP.getFreeSketchSpace());
    Serial.print("  Free heap: ");
    Serial.println(ESP.getFreeHeap());
    Serial.print("  Current firmware version: ");
    Serial.println(TANTALUM_FIRMWARE_VERSION);
    if (targetVersion != nullptr && strlen(targetVersion) > 0) {
      Serial.print("  Target OTA version: ");
      Serial.println(targetVersion);
    }
  }

  void configureSecureClients() {
#if defined(ESP32)
    if (strlen(TANTALUM_MQTT_CA_CERT) > 0) {
      mqttSecureClient.setCACert(TANTALUM_MQTT_CA_CERT);
    }
#elif defined(ESP8266)
    if (strlen(TANTALUM_MQTT_CA_CERT) > 0) {
      mqttSecureClient.setTrustAnchors(&mqttTrustAnchor);
    }
#endif
#if TANTALUM_HAS_PUBSUBCLIENT
    mqttClient.setServer(TANTALUM_MQTT_HOST, TANTALUM_MQTT_PORT);
    mqttClient.setCallback([this](char* topic, byte* payload, unsigned int length) {
      handleMqttMessage(topic, payload, length);
    });
#endif
  }

  void configureWifiDiagnostics() {
#if defined(ESP32)
    WiFi.onEvent([](arduino_event_id_t event, arduino_event_info_t info) {
      if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
        tantalumLastWifiDisconnectReason = static_cast<int>(info.wifi_sta_disconnected.reason);
      }
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
#endif
  }

  const char* wifiStatusName(wl_status_t status) {
    switch (status) {
      case WL_IDLE_STATUS: return "IDLE";
      case WL_NO_SSID_AVAIL: return "NO_SSID_AVAIL";
      case WL_SCAN_COMPLETED: return "SCAN_COMPLETED";
      case WL_CONNECTED: return "CONNECTED";
      case WL_CONNECT_FAILED: return "CONNECT_FAILED";
      case WL_CONNECTION_LOST: return "CONNECTION_LOST";
      case WL_DISCONNECTED: return "DISCONNECTED";
      default: return "UNKNOWN";
    }
  }

  const char* wifiAuthModeName(int authMode) {
#if defined(ESP32)
    switch (static_cast<wifi_auth_mode_t>(authMode)) {
      case WIFI_AUTH_OPEN: return "OPEN";
      case WIFI_AUTH_WEP: return "WEP";
      case WIFI_AUTH_WPA_PSK: return "WPA_PSK";
      case WIFI_AUTH_WPA2_PSK: return "WPA2_PSK";
      case WIFI_AUTH_WPA_WPA2_PSK: return "WPA_WPA2_PSK";
      case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2_ENTERPRISE";
      case WIFI_AUTH_WPA3_PSK: return "WPA3_PSK";
      case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2_WPA3_PSK";
      default: return "UNKNOWN";
    }
#else
    (void)authMode;
    return "UNKNOWN";
#endif
  }

  void printWifiScanForSsid(const char* targetSsid) {
    if (targetSsid == nullptr || strlen(targetSsid) == 0) {
      return;
    }

    String target = String(targetSsid);
    Serial.print("  Scanning for SSID: ");
    Serial.println(target);
    WiFi.disconnect(false);
    delay(300);
    WiFi.mode(WIFI_STA);
#if defined(ESP32)
    int networkCount = WiFi.scanNetworks(false, true);
#else
    int networkCount = WiFi.scanNetworks();
#endif
    if (networkCount < 0) {
      Serial.print("  WiFi scan failed: ");
      Serial.println(networkCount);
      return;
    }

    int matchCount = 0;
    for (int index = 0; index < networkCount; index++) {
      if (WiFi.SSID(index) != target) {
        continue;
      }

      matchCount++;
      Serial.print("  SSID match ");
      Serial.print(matchCount);
      Serial.print(": RSSI ");
      Serial.print(WiFi.RSSI(index));
#if defined(ESP32)
      Serial.print(", channel ");
      Serial.print(WiFi.channel(index));
      int authMode = static_cast<int>(WiFi.encryptionType(index));
      Serial.print(", auth ");
      Serial.print(authMode);
      Serial.print(" ");
      Serial.print(wifiAuthModeName(authMode));
#endif
      Serial.println();
    }

    if (matchCount == 0) {
      Serial.print("  SSID was not found. Networks visible: ");
      Serial.println(networkCount);
    }

    WiFi.scanDelete();
  }

  void printWifiConnectionFailure(const char* context, const char* targetSsid = nullptr) {
    wl_status_t status = WiFi.status();
    Serial.print(context);
    Serial.print(" WiFi connect failed. Status: ");
    Serial.print(static_cast<int>(status));
    Serial.print(" ");
    Serial.println(wifiStatusName(status));
#if defined(ESP32)
    int reason = tantalumLastWifiDisconnectReason;
    if (reason > 0) {
      Serial.print("  Disconnect reason: ");
      Serial.print(reason);
      Serial.print(" ");
      Serial.println(WiFi.disconnectReasonName(static_cast<wifi_err_reason_t>(reason)));
    }
#endif
    Serial.print("  RSSI: ");
    Serial.println(WiFi.RSSI());
    printWifiScanForSsid(targetSsid);
  }

  void configureWifiStationIdentity() {
    if (strlen(TANTALUM_WIFI_HOSTNAME) == 0) {
      return;
    }

#if defined(ESP32)
    WiFi.setHostname(TANTALUM_WIFI_HOSTNAME);
#elif defined(ESP8266)
    WiFi.hostname(TANTALUM_WIFI_HOSTNAME);
#endif
  }

  void handleSerialProvisioning() {
    while (Serial.available() > 0) {
      char incoming = static_cast<char>(Serial.read());
      if (incoming == '\r') {
        continue;
      }

      if (incoming == '\n') {
        String line = serialLineBuffer;
        serialLineBuffer = "";
        line.trim();
        if (line.length() > 0) {
          handleSerialProvisioningLine(line);
        }
        continue;
      }

      if (serialLineBuffer.length() < 768) {
        serialLineBuffer += incoming;
      } else {
        serialLineBuffer = "";
        writeSerialProvisioningStatus("failed", "Serial command was too large.");
      }
    }
  }

  void handleSerialProvisioningLine(const String& line) {
    DynamicJsonDocument doc(768);
    DeserializationError error = deserializeJson(doc, line);
    if (error) {
      return;
    }

    const char* type = doc["type"] | "";
    if (strcmp(type, "wifi-provision") != 0) {
      return;
    }

    const char* boardId = doc["boardId"] | "";
    const char* ssid = doc["ssid"] | "";
    const char* password = doc["password"] | "";
    const char* nonce = doc["nonce"] | "";
    const char* signature = doc["signature"] | "";

    if (strcmp(boardId, TANTALUM_BOARD_ID) != 0) {
      writeSerialProvisioningStatus("failed", "Board ID mismatch.");
      return;
    }

    if (strlen(ssid) == 0) {
      writeSerialProvisioningStatus("failed", "WiFi SSID is required.");
      return;
    }

    if (!verifyWifiProvisioningSignature(ssid, password, nonce, signature)) {
      writeSerialProvisioningStatus("failed", "Invalid provisioning signature.");
      return;
    }

    writeSerialProvisioningStatus("accepted", "");
    Serial.println("Accepted USB WiFi provisioning command.");
    bool connected = applyWifiCredentials(ssid, password);
    if (connected) {
      Serial.println("WiFi connected from USB provisioning; sending Tantalum heartbeat.");
      sendHeartbeat();
      writeSerialProvisioningStatus("connected", "");
      return;
    }

    writeSerialProvisioningStatus("failed", "The board could not connect to WiFi.");
  }

  void writeSerialProvisioningStatus(const char* status, const char* error) {
    DynamicJsonDocument response(192);
    response["type"] = "wifi-provision";
    response["status"] = status;
    if (error && strlen(error) > 0) {
      response["error"] = error;
    }
    serializeJson(response, Serial);
    Serial.println();
  }

  bool verifyWifiProvisioningSignature(const char* ssid, const char* password, const char* nonce, const char* signature) {
    if (strlen(TANTALUM_COMMAND_SECRET) == 0 || strlen(signature) == 0 || strlen(nonce) == 0) {
      return false;
    }

    String message = String("wifi-provision") + "\n" + TANTALUM_BOARD_ID + "\n" + ssid + "\n" + password + "\n" + nonce;
    String expected = hmacSha256Hex(TANTALUM_COMMAND_SECRET, message);
    return expected.length() > 0 && expected.equalsIgnoreCase(signature);
  }

  bool applyWifiCredentials(const char* ssid, const char* password) {
#if defined(ESP32)
    preferences.putString("wifi_ssid", ssid);
    preferences.putString("wifi_password", password);
#endif

    WiFi.disconnect(true);
    delay(250);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    configureWifiStationIdentity();
    Serial.println("USB provisioning WiFi connect attempt starting.");
    printWifiScanForSsid(ssid);
#if defined(ESP8266)
    WiFi.persistent(true);
#endif
    WiFi.begin(ssid, password);

    unsigned long startedAt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startedAt < TANTALUM_WIFI_CONNECT_TIMEOUT_MS) {
      delay(250);
    }

    provisioningActive = false;
    if (WiFi.status() == WL_CONNECTED) {
      return true;
    }

    printWifiConnectionFailure("USB provisioning", ssid);
    return false;
  }

  bool connectToWiFi() {
    if (WiFi.status() == WL_CONNECTED) {
      return true;
    }

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    configureWifiStationIdentity();
#if defined(ESP32)
    String savedSsid = preferences.getString("wifi_ssid", "");
    String savedPassword = preferences.getString("wifi_password", "");
    if (savedSsid.length() > 0) {
      Serial.println("Using USB-provisioned WiFi credentials.");
      printWifiScanForSsid(savedSsid.c_str());
      WiFi.begin(savedSsid.c_str(), savedPassword.c_str());
    } else {
      Serial.println("No USB-provisioned WiFi SSID is stored; trying SDK-stored WiFi credentials.");
      WiFi.begin();
    }
#else
    WiFi.begin();
#endif

    Serial.println("Connecting with stored WiFi credentials.");
    unsigned long startedAt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startedAt < TANTALUM_WIFI_CONNECT_TIMEOUT_MS) {
      delay(250);
      Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("WiFi connected: ");
      Serial.println(WiFi.localIP());
      provisioningActive = false;
      return true;
    }

    printWifiConnectionFailure("Stored credentials", savedSsid.c_str());
    Serial.println("Stored WiFi credentials failed; opening provisioning mode.");
    startProvisioning("wifi-failed");
    return false;
  }

  void startProvisioning(const char* reason) {
    if (provisioningActive) {
      return;
    }

    provisioningActive = true;
    provisioningStartedAt = millis();
    Serial.print("Opening provisioning mode: ");
    Serial.println(reason);

#if defined(ESP32)
#if TANTALUM_HAS_ESP_WIFI_PROV
    const bool resetProvisioned = true;
    const char* serviceKey = nullptr;
#if defined(CONFIG_IDF_TARGET_ESP32S2)
    WiFiProv.beginProvision(
      WIFI_PROV_SCHEME_SOFTAP,
      WIFI_PROV_SCHEME_HANDLER_NONE,
      WIFI_PROV_SECURITY_1,
      TANTALUM_PROVISIONING_POP,
      TANTALUM_PROVISIONING_SERVICE_NAME,
      serviceKey,
      nullptr,
      resetProvisioned
    );
    Serial.print("SoftAP provisioning SSID: ");
#else
    static const uint8_t serviceUuid[16] = {
      0xb4, 0xdf, 0x5a, 0x1c, 0x3f, 0x6e, 0x46, 0xa2,
      0x9c, 0x4e, 0x65, 0x2f, 0xf1, 0x60, 0x42, 0x30
    };
    WiFiProv.beginProvision(
      WIFI_PROV_SCHEME_BLE,
      WIFI_PROV_SCHEME_HANDLER_FREE_BTDM,
      WIFI_PROV_SECURITY_1,
      TANTALUM_PROVISIONING_POP,
      TANTALUM_PROVISIONING_SERVICE_NAME,
      serviceKey,
      serviceUuid,
      resetProvisioned
    );
    Serial.print("BLE provisioning name: ");
#endif
    Serial.println(TANTALUM_PROVISIONING_SERVICE_NAME);
    Serial.print("Proof of possession: ");
    Serial.println(TANTALUM_PROVISIONING_POP);
#else
    Serial.println("WiFiProv is unavailable in this ESP32 core.");
#endif
#elif defined(ESP8266)
    startEsp8266SoftApPortal();
#endif
  }

#if defined(ESP8266)
  void startEsp8266SoftApPortal() {
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(TANTALUM_PROVISIONING_SERVICE_NAME);

    tantalumProvisioningServer.on("/", HTTP_GET, []() {
      String html = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Tantalum WiFi</title></head><body>";
      html += "<h1>Tantalum WiFi Setup</h1><form method=\"POST\" action=\"/save\">";
      html += "<label>SSID <input name=\"ssid\" required></label><br>";
      html += "<label>Password <input name=\"password\" type=\"password\"></label><br>";
      html += "<button type=\"submit\">Save</button></form></body></html>";
      tantalumProvisioningServer.send(200, "text/html", html);
    });

    tantalumProvisioningServer.on("/save", HTTP_POST, [this]() {
      tantalumPendingSsid = tantalumProvisioningServer.arg("ssid");
      tantalumPendingPassword = tantalumProvisioningServer.arg("password");
      WiFi.persistent(true);
      WiFi.mode(WIFI_STA);
      configureWifiStationIdentity();
      WiFi.begin(tantalumPendingSsid.c_str(), tantalumPendingPassword.c_str());
      tantalumProvisioningServer.send(200, "text/plain", "Saved. The board is connecting to WiFi.");
    });

    tantalumProvisioningServer.begin();
    Serial.print("SoftAP provisioning SSID: ");
    Serial.println(TANTALUM_PROVISIONING_SERVICE_NAME);
  }
#endif

  void maintainMqtt() {
#if TANTALUM_HAS_PUBSUBCLIENT
    if (strlen(TANTALUM_MQTT_HOST) == 0 || strlen(TANTALUM_MQTT_TOPIC) == 0) {
      return;
    }

    if (strlen(TANTALUM_MQTT_CA_CERT) == 0) {
      if (!mqttConfigWarningLogged) {
        Serial.println("MQTT disabled: TLS CA certificate is required.");
        mqttConfigWarningLogged = true;
      }
      return;
    }

    if (mqttClient.connected()) {
      return;
    }

    unsigned long now = millis();
    if (now - lastMqttAttemptAt < TANTALUM_MQTT_RETRY_MS) {
      return;
    }

    lastMqttAttemptAt = now;
    String clientId = String("tantalum-") + TANTALUM_BOARD_ID;
    bool connected = false;

    if (strlen(TANTALUM_MQTT_USERNAME) > 0 || strlen(TANTALUM_MQTT_PASSWORD) > 0) {
      connected = mqttClient.connect(clientId.c_str(), TANTALUM_MQTT_USERNAME, TANTALUM_MQTT_PASSWORD);
    } else {
      connected = mqttClient.connect(clientId.c_str());
    }

    if (connected) {
      mqttClient.subscribe(TANTALUM_MQTT_TOPIC);
      Serial.print("MQTT subscribed: ");
      Serial.println(TANTALUM_MQTT_TOPIC);
    } else {
      Serial.print("MQTT connect failed, state ");
      Serial.println(mqttClient.state());
    }
#endif
  }

  void handleMqttMessage(char*, byte* payload, unsigned int length) {
    DynamicJsonDocument doc(1536);
    DeserializationError error = deserializeJson(doc, payload, length);
    if (error) {
      Serial.println("Ignored invalid MQTT JSON.");
      return;
    }

    const char* action = doc["action"] | "";
    const char* deploymentId = doc["deploymentId"] | "";
    const char* nonce = doc["nonce"] | "";
    const char* issuedAt = doc["issuedAt"] | "";
    const char* signature = doc["signature"] | "";

    if (!verifyCommandSignature(action, deploymentId, nonce, issuedAt, signature)) {
      Serial.println("Ignored unsigned MQTT command.");
      return;
    }

    if (strcmp(action, "check-update") == 0) {
      checkForUpdates();
      return;
    }

    if (strcmp(action, "start-provisioning") == 0) {
      startProvisioning("mqtt");
    }
  }

  bool verifyCommandSignature(const char* action, const char* deploymentId, const char* nonce, const char* issuedAt, const char* signature) {
    if (strlen(TANTALUM_COMMAND_SECRET) == 0 || strlen(signature) == 0) {
      return false;
    }

    String message = String(action) + "\n" + deploymentId + "\n" + nonce + "\n" + issuedAt;
    String expected = hmacSha256Hex(TANTALUM_COMMAND_SECRET, message);
    return expected.length() > 0 && expected.equalsIgnoreCase(signature);
  }

  String hmacSha256Hex(const char* key, const String& message) {
#if defined(ESP32)
    unsigned char output[32];
    const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!info) {
      return "";
    }
    mbedtls_md_hmac(info, reinterpret_cast<const unsigned char*>(key), strlen(key), reinterpret_cast<const unsigned char*>(message.c_str()), message.length(), output);
    return bytesToHex(output, sizeof(output));
#elif defined(ESP8266)
    unsigned char output[32];
    br_hmac_key_context keyContext;
    br_hmac_context hmacContext;
    br_hmac_key_init(&keyContext, &br_sha256_vtable, key, strlen(key));
    br_hmac_init(&hmacContext, &keyContext, 0);
    br_hmac_update(&hmacContext, message.c_str(), message.length());
    br_hmac_out(&hmacContext, output);
    return bytesToHex(output, sizeof(output));
#endif
  }

  String bytesToHex(const unsigned char* bytes, size_t length) {
    static const char* hex = "0123456789abcdef";
    String out;
    out.reserve(length * 2);
    for (size_t index = 0; index < length; index += 1) {
      out += hex[(bytes[index] >> 4) & 0x0f];
      out += hex[bytes[index] & 0x0f];
    }
    return out;
  }

  void addIdentityPayload(JsonDocument& payload) {
    payload["boardId"] = TANTALUM_BOARD_ID;
    payload["apiToken"] = TANTALUM_API_TOKEN;
    payload["currentVersion"] = TANTALUM_FIRMWARE_VERSION;
    payload["firmwareId"] = TANTALUM_FIRMWARE_ID;
    payload["runtimeVersion"] = TANTALUM_RUNTIME_VERSION;
    payload["rssi"] = WiFi.RSSI();
    payload["freeHeap"] = ESP.getFreeHeap();
    payload["uptime"] = millis() / 1000UL;
    payload["ipAddress"] = WiFi.localIP().toString();
  }

  struct TantalumUrl {
    String scheme;
    String host;
    String path;
    uint16_t port = 443;
    bool valid = false;
  };

  struct TantalumHttpResponse {
    int status = 0;
    size_t contentLength = 0;
    bool hasContentLength = false;
    bool chunked = false;
    String contentType;
    String location;
    String body;
  };

  bool parseHttpsUrl(const String& url, TantalumUrl& parsed) {
    parsed = TantalumUrl();
    String trimmed = url;
    trimmed.trim();
    if (!trimmed.startsWith("https://")) {
      return false;
    }

    parsed.scheme = "https";
    int hostStart = 8;
    int pathStart = trimmed.indexOf('/', hostStart);
    String hostPort = pathStart >= 0 ? trimmed.substring(hostStart, pathStart) : trimmed.substring(hostStart);
    parsed.path = pathStart >= 0 ? trimmed.substring(pathStart) : "/";
    if (parsed.path.length() == 0) {
      parsed.path = "/";
    }

    int portIndex = hostPort.lastIndexOf(':');
    if (portIndex > 0) {
      parsed.host = hostPort.substring(0, portIndex);
      int parsedPort = hostPort.substring(portIndex + 1).toInt();
      parsed.port = parsedPort > 0 ? static_cast<uint16_t>(parsedPort) : 443;
    } else {
      parsed.host = hostPort;
      parsed.port = 443;
    }

    parsed.host.trim();
    parsed.valid = parsed.host.length() > 0;
    return parsed.valid;
  }

  String buildOrigin(const TantalumUrl& url) {
    String origin = "https://" + url.host;
    if (url.port != 443) {
      origin += ":";
      origin += String(url.port);
    }
    return origin;
  }

  String resolveRedirectUrl(const TantalumUrl& current, const String& location) {
    String target = location;
    target.trim();
    if (target.startsWith("https://")) {
      return target;
    }
    if (target.startsWith("/")) {
      return buildOrigin(current) + target;
    }

    int queryIndex = current.path.indexOf('?');
    String basePath = queryIndex >= 0 ? current.path.substring(0, queryIndex) : current.path;
    int slashIndex = basePath.lastIndexOf('/');
    String directory = slashIndex >= 0 ? basePath.substring(0, slashIndex + 1) : "/";
    return buildOrigin(current) + directory + target;
  }

  bool readHttpLine(Client& client, String& line, unsigned long timeoutMs = TANTALUM_HTTP_TIMEOUT_MS) {
    line = "";
    unsigned long lastDataAt = millis();
    while (millis() - lastDataAt < timeoutMs) {
      while (client.available() > 0) {
        char c = static_cast<char>(client.read());
        lastDataAt = millis();
        if (c == '\n') {
          if (line.endsWith("\r")) {
            line.remove(line.length() - 1);
          }
          return true;
        }
        if (line.length() < 512) {
          line += c;
        }
      }

      if (!client.connected() && client.available() <= 0) {
        return line.length() > 0;
      }
      delay(1);
      yield();
    }
    return false;
  }

  size_t readBytesWithTimeout(Client& client, uint8_t* buffer, size_t expected, unsigned long timeoutMs = TANTALUM_HTTP_TIMEOUT_MS) {
    size_t readTotal = 0;
    unsigned long lastDataAt = millis();
    while (readTotal < expected && millis() - lastDataAt < timeoutMs) {
      int availableBytes = client.available();
      if (availableBytes > 0) {
        size_t toRead = min(expected - readTotal, static_cast<size_t>(availableBytes));
        int readNow = client.read(buffer + readTotal, toRead);
        if (readNow > 0) {
          readTotal += static_cast<size_t>(readNow);
          lastDataAt = millis();
        }
        continue;
      }

      if (!client.connected()) {
        break;
      }
      delay(1);
      yield();
    }
    return readTotal;
  }

  bool readHttpHeaders(Client& client, TantalumHttpResponse& response) {
    String statusLine;
    if (!readHttpLine(client, statusLine)) {
      Serial.println("HTTP response did not include a status line.");
      return false;
    }
    statusLine.trim();
    if (!statusLine.startsWith("HTTP/")) {
      Serial.print("Invalid HTTP status line: ");
      Serial.println(statusLine);
      return false;
    }

    int firstSpace = statusLine.indexOf(' ');
    int secondSpace = firstSpace >= 0 ? statusLine.indexOf(' ', firstSpace + 1) : -1;
    response.status = statusLine.substring(firstSpace + 1, secondSpace > firstSpace ? secondSpace : statusLine.length()).toInt();

    for (;;) {
      String line;
      if (!readHttpLine(client, line)) {
        Serial.println("HTTP headers ended unexpectedly.");
        return false;
      }
      if (line.length() == 0) {
        break;
      }

      int colon = line.indexOf(':');
      if (colon <= 0) {
        continue;
      }

      String name = line.substring(0, colon);
      String value = line.substring(colon + 1);
      name.trim();
      value.trim();
      name.toLowerCase();

      if (name == "content-length") {
        long parsedLength = value.toInt();
        if (parsedLength >= 0) {
          response.contentLength = static_cast<size_t>(parsedLength);
          response.hasContentLength = true;
        }
      } else if (name == "transfer-encoding") {
        String lowerValue = value;
        lowerValue.toLowerCase();
        response.chunked = lowerValue.indexOf("chunked") >= 0;
      } else if (name == "content-type") {
        response.contentType = value;
      } else if (name == "location") {
        response.location = value;
      }
    }

    return true;
  }

  bool appendHttpBodyBytes(String& body, const uint8_t* bytes, size_t length, size_t maxBytes) {
    if (body.length() + length > maxBytes) {
      Serial.println("HTTP response body was larger than the runtime parser limit.");
      return false;
    }
    for (size_t index = 0; index < length; index += 1) {
      body += static_cast<char>(bytes[index]);
    }
    return true;
  }

  bool readHttpBodyToString(Client& client, TantalumHttpResponse& response, size_t maxBytes = TANTALUM_HTTP_BODY_MAX_BYTES) {
    response.body = "";
    response.body.reserve(response.hasContentLength ? min(response.contentLength, maxBytes) : 512);
    uint8_t buffer[256];

    if (response.chunked) {
      for (;;) {
        String chunkLine;
        if (!readHttpLine(client, chunkLine)) {
          Serial.println("Chunked HTTP body ended before the next chunk header.");
          return false;
        }
        int extensionIndex = chunkLine.indexOf(';');
        if (extensionIndex >= 0) {
          chunkLine = chunkLine.substring(0, extensionIndex);
        }
        chunkLine.trim();
        size_t chunkSize = static_cast<size_t>(strtoul(chunkLine.c_str(), nullptr, 16));
        if (chunkSize == 0) {
          String trailer;
          do {
            if (!readHttpLine(client, trailer)) {
              break;
            }
          } while (trailer.length() > 0);
          return true;
        }

        size_t remaining = chunkSize;
        while (remaining > 0) {
          size_t toRead = min(remaining, sizeof(buffer));
          size_t readNow = readBytesWithTimeout(client, buffer, toRead);
          if (readNow == 0) {
            Serial.println("Chunked HTTP body ended during chunk data.");
            return false;
          }
          if (!appendHttpBodyBytes(response.body, buffer, readNow, maxBytes)) {
            return false;
          }
          remaining -= readNow;
        }

        uint8_t crlf[2];
        readBytesWithTimeout(client, crlf, sizeof(crlf), 2000UL);
      }
    }

    if (response.hasContentLength) {
      size_t remaining = response.contentLength;
      while (remaining > 0) {
        size_t toRead = min(remaining, sizeof(buffer));
        size_t readNow = readBytesWithTimeout(client, buffer, toRead);
        if (readNow == 0) {
          Serial.println("HTTP body ended before content-length was satisfied.");
          return false;
        }
        if (!appendHttpBodyBytes(response.body, buffer, readNow, maxBytes)) {
          return false;
        }
        remaining -= readNow;
      }
      return true;
    }

    unsigned long lastDataAt = millis();
    while (client.connected() || client.available() > 0) {
      if (client.available() > 0) {
        int readNow = client.read(buffer, sizeof(buffer));
        if (readNow > 0) {
          if (!appendHttpBodyBytes(response.body, buffer, static_cast<size_t>(readNow), maxBytes)) {
            return false;
          }
          lastDataAt = millis();
        }
        continue;
      }

      if (millis() - lastDataAt > TANTALUM_HTTP_TIMEOUT_MS) {
        Serial.println("Timed out waiting for HTTP body.");
        return false;
      }
      delay(1);
      yield();
    }

    return true;
  }

  void printGatewayResponseBody(const String& body) {
    if (body.length() == 0) {
      return;
    }

    Serial.print("Gateway response: ");
    if (body.length() > 600) {
      Serial.println(body.substring(0, 600));
      Serial.println("Gateway response truncated.");
      return;
    }
    Serial.println(body);
  }

  void printGatewayDiagnostics(bool force = false) {
    unsigned long now = millis();
    if (!force && lastGatewayDiagnosticAt != 0 && now - lastGatewayDiagnosticAt < TANTALUM_GATEWAY_DIAGNOSTIC_MS) {
      return;
    }
    lastGatewayDiagnosticAt = now;

    String endpoint = normalizedAppwriteEndpoint();
    String host = extractHostFromUrl(endpoint);
    IPAddress resolved;
    bool dnsOk = host.length() > 0 && WiFi.hostByName(host.c_str(), resolved);

    Serial.println("Tantalum network diagnostics:");
    Serial.print("  WiFi status: ");
    Serial.println(WiFi.status());
    Serial.print("  RSSI: ");
    Serial.println(WiFi.RSSI());
    Serial.print("  Local IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("  Gateway: ");
    Serial.println(WiFi.gatewayIP());
    Serial.print("  DNS: ");
    Serial.println(WiFi.dnsIP());
    Serial.print("  Appwrite host: ");
    Serial.println(host);
    Serial.print("  DNS resolved: ");
    Serial.println(dnsOk ? resolved.toString() : String("failed"));
    if (dnsOk) {
      WiFiClient tcpProbe;
      bool tcpOk = tcpProbe.connect(host.c_str(), 443);
      Serial.print("  TCP 443 reachable: ");
      Serial.println(tcpOk ? "yes" : "no");
      tcpProbe.stop();
    }
    Serial.print("  Free heap: ");
    Serial.println(ESP.getFreeHeap());
  }

#if defined(ESP32)
  void printSecureClientError(WiFiClientSecure& client) {
    char errorText[160] = {0};
    int errorCode = client.lastError(errorText, sizeof(errorText));
    Serial.print("  TLS client error: ");
    Serial.print(errorCode);
    Serial.print(" ");
    Serial.println(errorText);
  }
#endif

#if defined(ESP8266)
  void printSecureClientError(BearSSL::WiFiClientSecure& client) {
    char errorText[160] = {0};
    int errorCode = client.getLastSSLError(errorText, sizeof(errorText));
    Serial.print("  TLS client error: ");
    Serial.print(errorCode);
    Serial.print(" ");
    Serial.println(errorText);
  }
#endif

#if defined(ESP32)
  bool connectVerifiedAppwriteClient(WiFiClientSecure& client, const TantalumUrl& url, const char* context) {
    IPAddress resolved;
    if (!WiFi.hostByName(url.host.c_str(), resolved)) {
      Serial.print(context);
      Serial.print(" DNS lookup failed for ");
      Serial.println(url.host);
      return false;
    }

    Serial.print(context);
    Serial.print(" DNS resolved ");
    Serial.print(url.host);
    Serial.print(" -> ");
    Serial.println(resolved);

    if (!configureAppwriteSecureClient(client)) {
      return false;
    }

    Serial.print(context);
    Serial.print(" opening verified TLS to ");
    Serial.print(url.host);
    Serial.print(":");
    Serial.println(url.port);
    if (!client.connect(url.host.c_str(), url.port)) {
      Serial.print(context);
      Serial.println(" verified TLS connect failed.");
      printSecureClientError(client);
      client.stop();
      return false;
    }
    return true;
  }
#endif

#if defined(ESP8266)
  bool connectVerifiedAppwriteClient(BearSSL::WiFiClientSecure& client, const TantalumUrl& url, const char* context) {
    IPAddress resolved;
    if (!WiFi.hostByName(url.host.c_str(), resolved)) {
      Serial.print(context);
      Serial.print(" DNS lookup failed for ");
      Serial.println(url.host);
      return false;
    }

    Serial.print(context);
    Serial.print(" DNS resolved ");
    Serial.print(url.host);
    Serial.print(" -> ");
    Serial.println(resolved);

    if (!configureAppwriteSecureClient(client)) {
      return false;
    }

    Serial.print(context);
    Serial.print(" opening verified TLS to ");
    Serial.print(url.host);
    Serial.print(":");
    Serial.println(url.port);
    if (!client.connect(url.host.c_str(), url.port)) {
      Serial.print(context);
      Serial.println(" verified TLS connect failed.");
      printSecureClientError(client);
      client.stop();
      return false;
    }
    return true;
  }
#endif

  bool sendHttpRequest(Client& client, const char* method, const TantalumUrl& url, const String& body, const char* contentType = "application/json") {
    client.print(method);
    client.print(" ");
    client.print(url.path);
    client.print(" HTTP/1.1\r\nHost: ");
    client.print(url.host);
    client.print("\r\nUser-Agent: TantalumCloudRuntime/");
    client.print(TANTALUM_RUNTIME_VERSION);
    client.print("\r\nAccept: application/json\r\nConnection: close\r\nX-Appwrite-Project: ");
    client.print(TANTALUM_APPWRITE_PROJECT_ID);
    if (contentType != nullptr && strlen(contentType) > 0) {
      client.print("\r\nContent-Type: ");
      client.print(contentType);
    }
    client.print("\r\nContent-Length: ");
    client.print(body.length());
    client.print("\r\n\r\n");
    if (body.length() > 0) {
      client.write(reinterpret_cast<const uint8_t*>(body.c_str()), body.length());
    }
    return true;
  }

  void logGatewayHttpFailure(const char* functionPath, int httpCode, const String& responseBody, uint8_t attempt) {
    Serial.print("Function execution failed for ");
    Serial.print(functionPath);
    Serial.print(" on attempt ");
    Serial.print(attempt);
    Serial.print(": ");
    Serial.println(httpCode);
    printGatewayResponseBody(responseBody);
    printGatewayDiagnostics(attempt == 1);
  }

  bool postGatewayExecution(const String& url, const String& requestBody, const char* functionPath, String& executionResponse) {
    TantalumUrl parsedUrl;
    if (!parseHttpsUrl(url, parsedUrl)) {
      Serial.print("Invalid Appwrite gateway URL: ");
      Serial.println(url);
      return false;
    }

    for (uint8_t attempt = 1; attempt <= TANTALUM_GATEWAY_ATTEMPTS; attempt += 1) {
      printRuntimeStatus(functionPath);
#if defined(ESP32)
      WiFiClientSecure gatewayClient;
      if (!connectVerifiedAppwriteClient(gatewayClient, parsedUrl, "Appwrite gateway")) {
        printGatewayDiagnostics(true);
        if (attempt < TANTALUM_GATEWAY_ATTEMPTS) {
          Serial.println("Retrying verified Appwrite request.");
          delay(500UL * attempt);
          continue;
        }
        return false;
      }
      Client& client = gatewayClient;
#else
      BearSSL::WiFiClientSecure gatewayClient;
      if (!connectVerifiedAppwriteClient(gatewayClient, parsedUrl, "Appwrite gateway")) {
        printGatewayDiagnostics(true);
        if (attempt < TANTALUM_GATEWAY_ATTEMPTS) {
          Serial.println("Retrying verified Appwrite request.");
          delay(500UL * attempt);
          continue;
        }
        return false;
      }
      Client& client = gatewayClient;
#endif

      sendHttpRequest(client, "POST", parsedUrl, requestBody);
      TantalumHttpResponse response;
      bool responseOk = readHttpHeaders(client, response) && readHttpBodyToString(client, response);
      client.stop();
      if (!responseOk) {
        Serial.print("Function execution response read failed for ");
        Serial.println(functionPath);
        printGatewayDiagnostics(attempt == 1);
      } else if (response.status == 201 || response.status == 200) {
        executionResponse = response.body;
        return true;
      } else {
        logGatewayHttpFailure(functionPath, response.status, response.body, attempt);
        if (response.status > 0) {
          return false;
        }
      }

      if (attempt < TANTALUM_GATEWAY_ATTEMPTS) {
        Serial.println("Retrying verified Appwrite request.");
      }
      delay(500UL * attempt);
    }

    return false;
  }

  bool executeGatewayFunction(const char* functionPath, JsonDocument& payload, DynamicJsonDocument& responseDoc) {
    if (strlen(TANTALUM_APPWRITE_ENDPOINT) == 0 || strlen(TANTALUM_DEVICE_GATEWAY_FUNCTION_ID) == 0) {
      Serial.println("Device gateway is not configured.");
      return false;
    }

    String url = normalizedAppwriteEndpoint() + "/functions/" + TANTALUM_DEVICE_GATEWAY_FUNCTION_ID + "/executions";

    String payloadText;
    serializeJson(payload, payloadText);

    DynamicJsonDocument executionDoc(2048);
    executionDoc["async"] = false;
    executionDoc["path"] = functionPath;
    executionDoc["method"] = "POST";
    JsonObject headers = executionDoc.createNestedObject("headers");
    headers["content-type"] = "application/json";
    executionDoc["body"] = payloadText;

    String requestBody;
    serializeJson(executionDoc, requestBody);

    String executionResponse;
    if (!postGatewayExecution(url, requestBody, functionPath, executionResponse)) {
      return false;
    }

    DynamicJsonDocument parsedExecution(8192);
    DeserializationError executionError = deserializeJson(parsedExecution, executionResponse);
    if (executionError) {
      Serial.print("Failed to parse execution response: ");
      Serial.println(executionError.c_str());
      return false;
    }

    int responseStatusCode = parsedExecution["responseStatusCode"] | 500;
    const char* responseBody = parsedExecution["responseBody"];
    if (responseStatusCode >= 400 || responseBody == nullptr) {
      Serial.print("Gateway returned status ");
      Serial.println(responseStatusCode);
      if (responseBody != nullptr) {
        printGatewayResponseBody(String(responseBody));
      }
      return false;
    }

    DeserializationError bodyError = deserializeJson(responseDoc, responseBody);
    if (bodyError) {
      Serial.print("Failed to parse gateway body: ");
      Serial.println(bodyError.c_str());
      return false;
    }

    bool ok = responseDoc["ok"] | false;
    if (!ok) {
      const char* errorMessage = responseDoc["error"] | "Gateway reported an unknown error.";
      Serial.print("Gateway response was not ok: ");
      Serial.println(errorMessage);
    }
    return ok;
  }

  void sendHeartbeat() {
    if (WiFi.status() != WL_CONNECTED) {
      return;
    }

    lastHeartbeatAt = millis();
    Serial.println("Sending Tantalum heartbeat.");

    DynamicJsonDocument payload(768);
    addIdentityPayload(payload);

    DynamicJsonDocument responseDoc(4096);
    if (!executeGatewayFunction("/heartbeat", payload, responseDoc)) {
      Serial.println("Tantalum heartbeat failed.");
      return;
    }

    Serial.println("Tantalum heartbeat accepted.");

    unsigned long nextPoll = responseDoc["data"]["recommendedPollMs"] | TANTALUM_DEFAULT_UPDATE_CHECK_MS;
    updateCheckIntervalMs = constrain(nextPoll, 30000UL, 60UL * 60UL * 1000UL);

    JsonVariant provisioningCommand = responseDoc["data"]["provisioningCommand"];
    if (!provisioningCommand.isNull() && (provisioningCommand["open"] | false)) {
      startProvisioning("heartbeat");
    }

    JsonVariant otaCommand = responseDoc["data"]["otaCommand"];
    if (!otaCommand.isNull()) {
      handleOtaCommand(otaCommand);
    }
  }

  void checkForUpdates() {
    if (WiFi.status() != WL_CONNECTED || otaInProgress) {
      return;
    }

    DynamicJsonDocument payload(768);
    addIdentityPayload(payload);

    DynamicJsonDocument responseDoc(4096);
    if (!executeGatewayFunction("/check-update", payload, responseDoc)) {
      return;
    }

    JsonVariant otaCommand = responseDoc["data"]["otaCommand"];
    if (!otaCommand.isNull()) {
      handleOtaCommand(otaCommand);
      return;
    }

    JsonVariant firmware = responseDoc["data"]["firmware"];
    if (!firmware.isNull()) {
      handleOtaCommand(firmware);
    }
  }

  void handleOtaCommand(JsonVariant command) {
    const char* deploymentId = command["deploymentId"] | "";
    const char* firmwareId = command["firmwareId"] | "";
    const char* version = command["version"] | "";
    const char* checksum = command["checksum"] | "";
    const char* downloadUrl = command["downloadUrl"] | "";
    const char* signature = command["signature"] | "";
    size_t size = command["size"] | 0;

    if (strlen(version) == 0 || strlen(downloadUrl) == 0) {
      return;
    }

    if (!verifyOtaCommandSignature(deploymentId, firmwareId, version, size, checksum, downloadUrl, signature)) {
      Serial.println("Ignored OTA command with invalid signature.");
      return;
    }

    if (shouldSkipRecentlyFailedOta(deploymentId)) {
      reportPendingOtaResult(false);
      return;
    }

    performOtaUpdate(deploymentId, firmwareId, version, checksum, downloadUrl, size);
  }

  bool verifyOtaCommandSignature(const char* deploymentId, const char* firmwareId, const char* version, size_t size, const char* checksum, const char* downloadUrl, const char* signature) {
    if (strlen(TANTALUM_API_TOKEN) == 0 || strlen(signature) == 0) {
      return false;
    }

    String message = String(deploymentId) + "\n" + firmwareId + "\n" + version + "\n" + String(size) + "\n" + checksum + "\n" + downloadUrl;
    String expected = hmacSha256Hex(TANTALUM_API_TOKEN, message);
    return expected.length() > 0 && expected.equalsIgnoreCase(signature);
  }

  struct TantalumSha256 {
#if defined(ESP32)
    mbedtls_sha256_context context;
#elif defined(ESP8266)
    br_sha256_context context;
#endif
  };

  void sha256Start(TantalumSha256& sha) {
#if defined(ESP32)
    mbedtls_sha256_init(&sha.context);
    mbedtls_sha256_starts(&sha.context, 0);
#elif defined(ESP8266)
    br_sha256_init(&sha.context);
#endif
  }

  void sha256Update(TantalumSha256& sha, const uint8_t* data, size_t length) {
#if defined(ESP32)
    mbedtls_sha256_update(&sha.context, data, length);
#elif defined(ESP8266)
    br_sha256_update(&sha.context, data, length);
#endif
  }

  String sha256FinishHex(TantalumSha256& sha) {
    unsigned char output[32];
#if defined(ESP32)
    mbedtls_sha256_finish(&sha.context, output);
    mbedtls_sha256_free(&sha.context);
#elif defined(ESP8266)
    br_sha256_out(&sha.context, output);
#endif
    return bytesToHex(output, sizeof(output));
  }

  String updateErrorString() {
#if defined(ESP32)
    return String(Update.errorString());
#elif defined(ESP8266)
    return Update.getErrorString();
#endif
  }

  void abortOtaWrite() {
#if defined(ESP32)
    Update.abort();
#elif defined(ESP8266)
    if (!Update.isFinished()) {
      Update.end();
    }
#endif
  }

  bool sendHttpGetRequest(Client& client, const TantalumUrl& url, const char* acceptHeader) {
    client.print("GET ");
    client.print(url.path);
    client.print(" HTTP/1.1\r\nHost: ");
    client.print(url.host);
    client.print("\r\nUser-Agent: TantalumCloudRuntime/");
    client.print(TANTALUM_RUNTIME_VERSION);
    client.print("\r\nAccept: ");
    client.print((acceptHeader != nullptr && strlen(acceptHeader) > 0) ? acceptHeader : "*/*");
    client.print("\r\nConnection: close\r\nX-Appwrite-Project: ");
    client.print(TANTALUM_APPWRITE_PROJECT_ID);
    client.print("\r\n\r\n");
    return true;
  }

  bool beginUpdateWriter(size_t expectedSize, String& errorMessage) {
    if (expectedSize == 0) {
      errorMessage = "OTA size is missing.";
      return false;
    }

    size_t freeSketchSpace = ESP.getFreeSketchSpace();
    Serial.print("OTA free sketch space: ");
    Serial.println(freeSketchSpace);
    if (expectedSize > freeSketchSpace) {
      errorMessage = "OTA image is larger than the available update partition.";
      return false;
    }

    if (!Update.begin(expectedSize, U_FLASH)) {
      errorMessage = String("Update.begin failed: ") + updateErrorString();
      return false;
    }

    return true;
  }

  bool writeOtaBytes(uint8_t* buffer, size_t length, TantalumSha256& sha, size_t& written, size_t expectedSize, size_t& lastProgressAt, String& errorMessage) {
    size_t updateWritten = Update.write(buffer, length);
    if (updateWritten != length) {
      errorMessage = String("Update.write failed after ") + String(written) + " bytes: " + updateErrorString();
      return false;
    }

    sha256Update(sha, buffer, length);
    written += length;

    if (written - lastProgressAt >= 65536UL || (expectedSize > 0 && written == expectedSize)) {
      Serial.print("OTA download progress: ");
      Serial.print(written);
      if (expectedSize > 0) {
        Serial.print("/");
        Serial.print(expectedSize);
      }
      Serial.println(" bytes");
      lastProgressAt = written;
    }

    return true;
  }

  bool streamOtaChunkedBody(Client& client, size_t expectedSize, TantalumSha256& sha, size_t& written, String& errorMessage) {
    uint8_t buffer[TANTALUM_OTA_CHUNK_BYTES];
    size_t lastProgressAt = 0;

    for (;;) {
      String chunkLine;
      if (!readHttpLine(client, chunkLine)) {
        errorMessage = "OTA chunked body ended before the next chunk header.";
        return false;
      }
      int extensionIndex = chunkLine.indexOf(';');
      if (extensionIndex >= 0) {
        chunkLine = chunkLine.substring(0, extensionIndex);
      }
      chunkLine.trim();
      size_t chunkSize = static_cast<size_t>(strtoul(chunkLine.c_str(), nullptr, 16));
      if (chunkSize == 0) {
        String trailer;
        do {
          if (!readHttpLine(client, trailer)) {
            break;
          }
        } while (trailer.length() > 0);
        return true;
      }

      size_t remaining = chunkSize;
      while (remaining > 0) {
        size_t toRead = min(remaining, sizeof(buffer));
        size_t readNow = readBytesWithTimeout(client, buffer, toRead);
        if (readNow == 0) {
          errorMessage = "OTA chunked body ended during chunk data.";
          return false;
        }
        if (!writeOtaBytes(buffer, readNow, sha, written, expectedSize, lastProgressAt, errorMessage)) {
          return false;
        }
        remaining -= readNow;
      }

      uint8_t crlf[2];
      readBytesWithTimeout(client, crlf, sizeof(crlf), 2000UL);
    }
  }

  bool streamOtaFixedBody(Client& client, size_t bodySize, TantalumSha256& sha, size_t& written, String& errorMessage) {
    uint8_t buffer[TANTALUM_OTA_CHUNK_BYTES];
    size_t remaining = bodySize;
    size_t lastProgressAt = 0;

    while (remaining > 0) {
      size_t toRead = min(remaining, sizeof(buffer));
      size_t readNow = readBytesWithTimeout(client, buffer, toRead);
      if (readNow == 0) {
        errorMessage = "OTA download ended before all expected bytes were received.";
        return false;
      }
      if (!writeOtaBytes(buffer, readNow, sha, written, bodySize, lastProgressAt, errorMessage)) {
        return false;
      }
      remaining -= readNow;
      yield();
    }

    return true;
  }

  bool streamOtaUntilClose(Client& client, size_t expectedSize, TantalumSha256& sha, size_t& written, String& errorMessage) {
    uint8_t buffer[TANTALUM_OTA_CHUNK_BYTES];
    size_t lastProgressAt = 0;
    unsigned long lastDataAt = millis();

    while (client.connected() || client.available() > 0) {
      if (client.available() > 0) {
        int readNow = client.read(buffer, sizeof(buffer));
        if (readNow > 0) {
          if (!writeOtaBytes(buffer, static_cast<size_t>(readNow), sha, written, expectedSize, lastProgressAt, errorMessage)) {
            return false;
          }
          lastDataAt = millis();
        }
        continue;
      }

      if (millis() - lastDataAt > TANTALUM_HTTP_TIMEOUT_MS) {
        errorMessage = "Timed out waiting for OTA download bytes.";
        return false;
      }
      delay(1);
      yield();
    }

    return true;
  }

  bool finishOtaWrite(size_t written, size_t expectedSize, const char* expectedChecksum, TantalumSha256& sha, String& errorMessage) {
    if (expectedSize > 0 && written != expectedSize) {
      errorMessage = String("OTA byte count mismatch. Received ") + String(written) + " of " + String(expectedSize) + " bytes.";
      abortOtaWrite();
      return false;
    }

    String actualChecksum = sha256FinishHex(sha);
    Serial.print("OTA SHA-256: ");
    Serial.println(actualChecksum);
    if (expectedChecksum != nullptr && strlen(expectedChecksum) > 0 && !actualChecksum.equalsIgnoreCase(expectedChecksum)) {
      errorMessage = "OTA checksum mismatch.";
      abortOtaWrite();
      return false;
    }

    if (!Update.end()) {
      errorMessage = String("Update.end failed: ") + updateErrorString();
      return false;
    }

    if (!Update.isFinished()) {
      errorMessage = "Update did not finish writing the inactive partition.";
      return false;
    }

    return true;
  }

  bool applyOtaFromResponse(Client& client, const TantalumHttpResponse& response, size_t expectedSize, const char* expectedChecksum, String& errorMessage) {
    size_t writeSize = response.hasContentLength ? response.contentLength : expectedSize;
    if (expectedSize > 0 && response.hasContentLength && response.contentLength != expectedSize) {
      errorMessage = "OTA content-length did not match Appwrite metadata size.";
      return false;
    }

    if (!beginUpdateWriter(writeSize, errorMessage)) {
      return false;
    }

    TantalumSha256 sha;
    sha256Start(sha);
    size_t written = 0;
    bool streamOk = false;

    if (response.chunked) {
      streamOk = streamOtaChunkedBody(client, expectedSize, sha, written, errorMessage);
    } else if (response.hasContentLength) {
      streamOk = streamOtaFixedBody(client, response.contentLength, sha, written, errorMessage);
    } else {
      streamOk = streamOtaUntilClose(client, expectedSize, sha, written, errorMessage);
    }

    if (!streamOk) {
      abortOtaWrite();
      return false;
    }

    return finishOtaWrite(written, expectedSize, expectedChecksum, sha, errorMessage);
  }

  bool downloadAndApplyOta(const char* downloadUrl, size_t expectedSize, const char* expectedChecksum, String& errorMessage) {
    String currentUrl = String(downloadUrl);
    for (uint8_t redirectCount = 0; redirectCount < 4; redirectCount += 1) {
      TantalumUrl parsedUrl;
      if (!parseHttpsUrl(currentUrl, parsedUrl)) {
        errorMessage = "OTA download URL is not a valid HTTPS URL.";
        return false;
      }

#if defined(ESP32)
      WiFiClientSecure otaClient;
      if (!connectVerifiedAppwriteClient(otaClient, parsedUrl, "OTA download")) {
        errorMessage = "OTA TLS connection failed.";
        return false;
      }
      Client& client = otaClient;
#else
      BearSSL::WiFiClientSecure otaClient;
      if (!connectVerifiedAppwriteClient(otaClient, parsedUrl, "OTA download")) {
        errorMessage = "OTA TLS connection failed.";
        return false;
      }
      Client& client = otaClient;
#endif

      sendHttpGetRequest(client, parsedUrl, "application/octet-stream");
      TantalumHttpResponse response;
      if (!readHttpHeaders(client, response)) {
        client.stop();
        errorMessage = "OTA HTTP response headers could not be read.";
        return false;
      }

      Serial.print("OTA download HTTP status: ");
      Serial.println(response.status);
      Serial.print("OTA content-length: ");
      Serial.println(response.hasContentLength ? String(response.contentLength) : String("missing"));
      Serial.print("OTA content-type: ");
      Serial.println(response.contentType.length() > 0 ? response.contentType : String("missing"));

      if (response.status == 301 || response.status == 302 || response.status == 303 || response.status == 307 || response.status == 308) {
        if (response.location.length() == 0) {
          client.stop();
          errorMessage = "OTA download redirect did not include a Location header.";
          return false;
        }
        currentUrl = resolveRedirectUrl(parsedUrl, response.location);
        Serial.print("Following OTA redirect to ");
        Serial.println(currentUrl);
        client.stop();
        continue;
      }

      if (response.status != 200) {
        readHttpBodyToString(client, response, 1024);
        printGatewayResponseBody(response.body);
        client.stop();
        errorMessage = String("OTA download returned HTTP ") + String(response.status) + ".";
        return false;
      }

      bool applied = applyOtaFromResponse(client, response, expectedSize, expectedChecksum, errorMessage);
      client.stop();
      return applied;
    }

    errorMessage = "OTA download followed too many redirects.";
    return false;
  }

  void performOtaUpdate(const char* deploymentId, const char* firmwareId, const char* version, const char* checksum, const char* downloadUrl, size_t size) {
    if (otaInProgress) {
      return;
    }

    otaInProgress = true;

    Serial.print("Starting OTA update to ");
    Serial.println(version);
    printRuntimeStatus("ota", version);
    if (size > 0) {
      Serial.print("Expected bytes: ");
      Serial.println(size);
    }
    if (strlen(checksum) > 0) {
      Serial.print("Expected SHA-256: ");
      Serial.println(checksum);
    }

    String errorMessage;
    if (!downloadAndApplyOta(downloadUrl, size, checksum, errorMessage)) {
      Serial.print("OTA update failed: ");
      Serial.println(errorMessage);
      storePendingOtaResult(deploymentId, firmwareId, version, "failed", errorMessage.c_str());
      rememberFailedOta(deploymentId);
      reportPendingOtaResult(true);
      otaInProgress = false;
      return;
    }

    clearFailedOta();
    storePendingOtaResult(deploymentId, firmwareId, version, "success", "");
    Serial.println("OTA update written and verified. Rebooting into new firmware.");
    delay(500);
    ESP.restart();
  }

  bool reportOtaResult(const char* deploymentId, const char* firmwareId, const char* version, const char* status, const char* errorMessage = "") {
    if (WiFi.status() != WL_CONNECTED) {
      return false;
    }

    DynamicJsonDocument payload(1024);
    addIdentityPayload(payload);
    payload["deploymentId"] = deploymentId;
    payload["firmwareId"] = firmwareId;
    payload["version"] = version;
    payload["status"] = status;
    payload["error"] = errorMessage;

    DynamicJsonDocument responseDoc(1024);
    bool accepted = executeGatewayFunction("/ota-result", payload, responseDoc);
    if (accepted) {
      Serial.print("OTA result accepted: ");
      Serial.println(status);
    } else {
      Serial.println("OTA result was not accepted; it will be retried.");
    }
    return accepted;
  }

  void storePendingOtaResult(const char* deploymentId, const char* firmwareId, const char* version, const char* status, const char* errorMessage) {
    String safeError = String(errorMessage ? errorMessage : "");
    if (safeError.length() > 240) {
      safeError = safeError.substring(0, 240);
    }

    pendingOtaDeploymentRam = deploymentId;
    pendingOtaFirmwareRam = firmwareId;
    pendingOtaVersionRam = version;
    pendingOtaStatusRam = status;
    pendingOtaErrorRam = safeError;

#if defined(ESP32)
    preferences.putString("pending_deploy", pendingOtaDeploymentRam);
    preferences.putString("pending_fw", pendingOtaFirmwareRam);
    preferences.putString("pending_ver", pendingOtaVersionRam);
    preferences.putString("pending_status", pendingOtaStatusRam);
    preferences.putString("pending_error", pendingOtaErrorRam);
#endif
  }

  bool loadPendingOtaResult(String& deploymentId, String& firmwareId, String& version, String& status, String& errorMessage) {
#if defined(ESP32)
    deploymentId = preferences.getString("pending_deploy", pendingOtaDeploymentRam);
    firmwareId = preferences.getString("pending_fw", pendingOtaFirmwareRam);
    version = preferences.getString("pending_ver", pendingOtaVersionRam);
    status = preferences.getString("pending_status", pendingOtaStatusRam);
    errorMessage = preferences.getString("pending_error", pendingOtaErrorRam);
#else
    deploymentId = pendingOtaDeploymentRam;
    firmwareId = pendingOtaFirmwareRam;
    version = pendingOtaVersionRam;
    status = pendingOtaStatusRam;
    errorMessage = pendingOtaErrorRam;
#endif

    if (deploymentId.length() == 0 || version.length() == 0) {
      return false;
    }

    if (status.length() == 0 && version == TANTALUM_FIRMWARE_VERSION) {
      status = "success";
    }
    return status.length() > 0;
  }

  void clearPendingOta() {
    pendingOtaDeploymentRam = "";
    pendingOtaFirmwareRam = "";
    pendingOtaVersionRam = "";
    pendingOtaStatusRam = "";
    pendingOtaErrorRam = "";
#if defined(ESP32)
    preferences.remove("pending_deploy");
    preferences.remove("pending_fw");
    preferences.remove("pending_ver");
    preferences.remove("pending_status");
    preferences.remove("pending_error");
#endif
  }

  bool reportPendingOtaResult(bool force = false) {
    if (WiFi.status() != WL_CONNECTED) {
      return false;
    }

    unsigned long now = millis();
    if (!force && lastPendingOtaResultAt != 0 && now - lastPendingOtaResultAt < TANTALUM_OTA_RESULT_RETRY_MS) {
      return false;
    }

    String pendingDeploy;
    String pendingFirmware;
    String pendingVersion;
    String pendingStatus;
    String pendingError;
    if (!loadPendingOtaResult(pendingDeploy, pendingFirmware, pendingVersion, pendingStatus, pendingError)) {
      return false;
    }

    if (pendingStatus == "success") {
      bool versionMatches = pendingVersion == TANTALUM_FIRMWARE_VERSION;
      bool firmwareMatches = pendingFirmware.length() == 0 || pendingFirmware == TANTALUM_FIRMWARE_ID;
      if (!versionMatches || !firmwareMatches) {
        pendingStatus = "failed";
        pendingError = String("OTA success did not boot expected firmware. Running version ") +
          TANTALUM_FIRMWARE_VERSION + " firmware " + TANTALUM_FIRMWARE_ID +
          "; expected version " + pendingVersion + " firmware " + pendingFirmware + ".";
        if (pendingError.length() > 240) {
          pendingError = pendingError.substring(0, 240);
        }
        storePendingOtaResult(pendingDeploy.c_str(), pendingFirmware.c_str(), pendingVersion.c_str(), pendingStatus.c_str(), pendingError.c_str());
      }
    }

    lastPendingOtaResultAt = now;
    Serial.print("Reporting pending OTA result: ");
    Serial.print(pendingStatus);
    Serial.print(" for ");
    Serial.println(pendingDeploy);

    if (!reportOtaResult(pendingDeploy.c_str(), pendingFirmware.c_str(), pendingVersion.c_str(), pendingStatus.c_str(), pendingError.c_str())) {
      return false;
    }

    clearPendingOta();
    if (pendingStatus == "failed") {
      clearFailedOta();
    }
    return true;
  }

  void rememberFailedOta(const char* deploymentId) {
    failedOtaDeploymentRam = deploymentId;
    lastFailedOtaAt = millis();
  }

  void clearFailedOta() {
    failedOtaDeploymentRam = "";
    lastFailedOtaAt = 0;
    lastFailedOtaSkipLogAt = 0;
  }

  bool shouldSkipRecentlyFailedOta(const char* deploymentId) {
    if (deploymentId == nullptr || strlen(deploymentId) == 0 || failedOtaDeploymentRam.length() == 0) {
      return false;
    }

    if (failedOtaDeploymentRam != deploymentId) {
      return false;
    }

    unsigned long now = millis();
    if (now - lastFailedOtaAt >= TANTALUM_FAILED_DEPLOYMENT_RETRY_MS) {
      return false;
    }

    if (lastFailedOtaSkipLogAt == 0 || now - lastFailedOtaSkipLogAt >= 60000UL) {
      Serial.print("Skipping recently failed OTA deployment ");
      Serial.print(deploymentId);
      Serial.println("; pending failure result will be retried instead.");
      lastFailedOtaSkipLogAt = now;
    }
    return true;
  }
};

static TantalumCloudRuntimeClass TantalumCloud;
