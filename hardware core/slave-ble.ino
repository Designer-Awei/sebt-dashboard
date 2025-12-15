/*
 * SEBT Slave BLE Broadcast Device
 * ESP32-C3 作为压力从机，单向BLE通知压力值
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// --- BLE配置 ---
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define DEVICE_NAME         "SEBT-Slave"

// --- 硬件引脚 ---
#define FORCE_SENSOR_PIN 34

// --- 采样配置 ---
const unsigned long SAMPLE_INTERVAL = 100; // 100ms采样
const int FILTER_SAMPLES = 5;

// --- 全局状态 ---
BLEServer* pServer = nullptr;
BLECharacteristic* pCharacteristic = nullptr;
bool deviceConnected = false;
int pressureHistory[FILTER_SAMPLES];
int historyIndex = 0;
unsigned long lastSampleTime = 0;

class SlaveServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    deviceConnected = true;
    Serial.println("BLE: Slave connected");
  }

  void onDisconnect(BLEServer* server) override {
    deviceConnected = false;
    Serial.println("BLE: Slave disconnected, restart advertising");
    server->getAdvertising()->start();
  }
};

/**
 * 初始化BLE服务与特征并开始广播
 */
void initBLE() {
  BLEDevice::init(DEVICE_NAME);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new SlaveServerCallbacks());

  BLEService* service = pServer->createService(SERVICE_UUID);
  pCharacteristic = service->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pCharacteristic->addDescriptor(new BLE2902());

  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(false);
  advertising->setMinPreferred(0x0);
  BLEDevice::startAdvertising();

  Serial.println("BLE: Slave advertising started");
}

/**
 * 滑动平均滤波
 * @param newReading 最新原始压力
 * @return 平滑后的压力值
 */
int filterPressure(int newReading) {
  pressureHistory[historyIndex] = newReading;
  historyIndex = (historyIndex + 1) % FILTER_SAMPLES;

  long sum = 0;
  for (int i = 0; i < FILTER_SAMPLES; i++) {
    sum += pressureHistory[i];
  }
  return sum / FILTER_SAMPLES;
}

/**
 * 采样并发送压力数据
 */
void sampleAndSend() {
  if (millis() - lastSampleTime < SAMPLE_INTERVAL) {
    return;
  }
  lastSampleTime = millis();

  int rawPressure = analogRead(FORCE_SENSOR_PIN);
  int filtered = filterPressure(rawPressure);

  if (!deviceConnected) {
    return;
  }

  String json = "{";
  json += "\"pressure\":" + String(filtered) + ",";
  json += "\"pressureRaw\":" + String(rawPressure) + ",";
  json += "\"timestamp\":" + String(millis()) + ",";
  json += "\"source\":\"slave\"";
  json += "}";

  pCharacteristic->setValue(json.c_str());
  pCharacteristic->notify();

  Serial.printf("BLE: Pressure sent raw=%d filtered=%d\n", rawPressure, filtered);
}

void setup() {
  Serial.begin(115200);
  Serial.println("SEBT Slave BLE starting...");

  for (int i = 0; i < FILTER_SAMPLES; i++) {
    pressureHistory[i] = 0;
  }

  pinMode(FORCE_SENSOR_PIN, INPUT);
  initBLE();
}

void loop() {
  sampleAndSend();
  delay(10);
}
