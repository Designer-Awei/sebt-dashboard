/*
 * SEBT Slave BLE Firmware (ESP32-C3 Version)
 * ESP32-C3 + NimBLE-Arduino 库实现原生BLE通信，发送压力传感器数据
 * 参考主机通信方式，使用NimBLE库，通过BLE驱动层连接
 * 数据格式: JSON格式 {pressure:3000}，发送间隔: 300ms
 *
 * 硬件配置:
 * - ESP32-C3
 * - 压力传感器（FSR/Force Sensor）
 *
 * BLE配置:
 * - Service UUID: 0000cccc-0000-1000-8000-00805f9b34fb
 * - Characteristic UUID: 0000dddd-0000-1000-8000-00805f9b34fb
 * - 特征值属性: Read | Notify
 * - 设备名称: SEBT-Slave-001
 *
 * ESP32-C3引脚定义:
 * - 压力传感器: GPIO 34 (ADC1_CH6)
 */

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>

// --- BLE配置 ---
#define SERVICE_UUID        "0000cccc-0000-1000-8000-00805f9b34fb"
#define CHARACTERISTIC_UUID "0000dddd-0000-1000-8000-00805f9b34fb"
#define DEVICE_NAME         "SEBT-Slave-001"

// --- 硬件引脚 ---
#define FORCE_SENSOR_PIN 34

// --- 发送配置 ---
const unsigned long SEND_INTERVAL = 300; // 300ms发送间隔（与主机一致）

// --- 全局状态 ---
NimBLEServer* pServer = nullptr;
NimBLECharacteristic* pCharacteristic = nullptr;
bool deviceConnected = false;
bool oldDeviceConnected = false;
unsigned long lastSendTime = 0;

// --- BLE 回调类 ---
class SlaveServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) {
        deviceConnected = true;
        Serial.println("BLE: 从机设备已连接");
        Serial.print("BLE: 客户端地址: ");
        Serial.println(connInfo.getAddress().toString().c_str());

        // 连接成功后开始发送数据
        NimBLEDevice::startAdvertising();
    };

    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) {
        deviceConnected = false;
        Serial.println("BLE: 从机设备已断开连接");
        Serial.print("BLE: 断开原因: ");
        Serial.println(reason);

        // 断开连接后重新开始广播
        NimBLEDevice::startAdvertising();
    };
};

class SlaveCharacteristicCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) {
        Serial.println("BLE: 特征值被读取");
    };

    void onStatus(NimBLECharacteristic* pCharacteristic, int code) {
        Serial.printf("BLE: 通知状态改变 - 代码: %d\n", code);
    };
};

/**
 * 初始化BLE服务和特征
 */
void initBLE() {
  Serial.println(F("BLE: 初始化NimBLE从机..."));

  // 初始化NimBLE设备
  NimBLEDevice::init(DEVICE_NAME);

  // 设置BLE设备参数
  NimBLEDevice::setPower(ESP_PWR_LVL_P9); // 设置发射功率
  NimBLEDevice::setSecurityAuth(false, false, false); // 禁用安全认证，简化连接

  // 创建BLE服务器
  pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new SlaveServerCallbacks());

  // 创建BLE服务
  NimBLEService* pService = pServer->createService(SERVICE_UUID);

  // 创建BLE特征
  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );

  // 设置特征回调
  pCharacteristic->setCallbacks(new SlaveCharacteristicCallbacks());

  // 设置初始值（空JSON）
  pCharacteristic->setValue("{}");

  // 启动服务
  pService->start();

  // 开始广播
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);

  NimBLEDevice::startAdvertising();

  Serial.println(F("BLE: 从机广播已启动"));
  Serial.print(F("BLE: Service UUID: "));
  Serial.println(SERVICE_UUID);
  Serial.print(F("BLE: Characteristic UUID: "));
  Serial.println(CHARACTERISTIC_UUID);
}

/**
 * 读取压力传感器并发送BLE数据
 * 数据格式: JSON {pressure:3000}
 */
void sendPressureData() {
  // 读取压力传感器（模拟数据，实际使用时需要连接真实的压力传感器）
  // 注意：ESP32-C3的GPIO34是输入专用引脚，不能输出，只能用于ADC读取
  int pressure = analogRead(FORCE_SENSOR_PIN);
  
  // 如果没有连接压力传感器，使用模拟数据
  if (pressure == 0 || pressure > 4095) {
    pressure = 3000; // 默认压力值
  }

  // 只有在有客户端连接时才发送数据
  if (deviceConnected && pCharacteristic) {
    // 构建JSON数据：{pressure:3000}
    String json = "{";
    json += "\"pressure\":" + String(pressure);
    json += "}";

    // 发送BLE通知
    pCharacteristic->setValue(json.c_str());
    pCharacteristic->notify();

    // 调试输出到USB串口
    Serial.printf("BLE: Pressure sent: %d\n", pressure);
  } else {
    // 没有客户端连接时的调试输出
    static unsigned long lastNoClientLog = 0;
    if (millis() - lastNoClientLog > 5000) { // 每5秒输出一次
      Serial.println(F("BLE: 无客户端连接，跳过数据发送"));
      lastNoClientLog = millis();
    }
  }
}

void setup() {
  // 初始化USB串口
  Serial.begin(115200);

  // ESP32-C3的USB串口需要时间初始化，等待更长时间
  delay(2000);

  // 发送启动信息
  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("SEBT Slave BLE (ESP32-C3) - Starting..."));
  Serial.println(F("========================================"));
  Serial.println(F("Serial Monitor Test - If you see this, serial is working!"));
  Serial.println(F("Baud Rate: 115200"));
  Serial.println(F("Line Ending: Both NL & CR"));
  Serial.println(F("========================================"));
  Serial.println();
  Serial.println(F("NimBLE-Arduino Library: https://github.com/h2zero/NimBLE-Arduino"));
  Serial.println();

  Serial.println(F("Step 1: Serial initialized"));

  // 初始化压力传感器引脚
  pinMode(FORCE_SENSOR_PIN, INPUT);
  Serial.println(F("Step 2: Force sensor pin initialized"));

  // 初始化BLE
  Serial.println(F("Step 3: Initializing BLE..."));
  initBLE();
  Serial.println(F("Step 3: BLE initialized"));

  // 初始化完成
  Serial.println(F("========================================"));
  Serial.println(F("SEBT BLE Slave - Ready!"));
  Serial.println(F("Waiting for BLE client connection..."));
  Serial.println(F("Data format: {pressure:3000}"));
  Serial.println(F("Send interval: 300ms"));
  Serial.println(F("========================================"));
}

void loop() {
  // 定时发送数据（300ms间隔，与主机一致）
  if (millis() - lastSendTime >= SEND_INTERVAL) {
    sendPressureData();
    lastSendTime = millis();
  }

  // 处理BLE连接状态变化
  if (deviceConnected != oldDeviceConnected) {
    if (deviceConnected) {
      Serial.println(F("BLE: 客户端已连接，开始发送压力数据"));
    } else {
      Serial.println(F("BLE: 客户端已断开，重新开始广播"));
    }
    oldDeviceConnected = deviceConnected;
  }

  // 每5秒输出一次状态
  static unsigned long lastStatusTime = 0;
  if (millis() - lastStatusTime >= 5000) {
    Serial.print(F("Status: Running, Uptime: "));
    Serial.print(millis() / 1000);
    Serial.print(F("s, Connected: "));
    Serial.println(deviceConnected ? F("Yes") : F("No"));
    lastStatusTime = millis();
  }

  // 让BLE库处理事件
  delay(10); // 简单的延时替代handleConnections
}
