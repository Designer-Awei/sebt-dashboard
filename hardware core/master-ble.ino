/*
 * SEBT Host BLE Firmware (ESP32-C3 Version)
 * ESP32-C3 + NimBLE-Arduino 库实现原生BLE通信，配合TCA9548A读取8方向TOF传感器数据
 * 直接通过BLE Notify发送传感器数据，无需中间串口转换
 * 数据范围: 0-2000mm（仅过滤超出范围的值），发送间隔: 300ms
 *
 * 硬件配置:
 * - ESP32-C3
 * - TCA9548A I2C多路复用器
 * - 8x VL53L1X TOF传感器
 *
 * BLE配置:
 * - Service UUID: 0000AAAA-0000-1000-8000-00805F9B34FB
 * - Characteristic UUID: 0000BBBB-0000-1000-8000-00805F9B34FB
 * - 特征值属性: Read | Notify (仅接收数据，无需Write)
 *
 * ESP32-C3引脚定义:
 * - I2C SDA: GPIO 8
 * - I2C SCL: GPIO 9
 * - LED: GPIO 10 (可选，用于状态指示)
 */

#include <Arduino.h>
#include <Wire.h>
#include <VL53L1X.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>

// --- BLE配置 ---
#define SERVICE_UUID        "0000aaaa-0000-1000-8000-00805f9b34fb"
#define CHARACTERISTIC_UUID "0000bbbb-0000-1000-8000-00805f9b34fb"
#define DEVICE_NAME         "SEBT-Host-001"

// --- TCA9548A配置 ---
#define TCA9548A_ADDR       0x70

// --- TOF传感器配置 ---
#define NUM_SENSORS         8
VL53L1X sensors[8];  // ESP32-C3有足够内存，可以使用对象数组

// --- I2C配置 ---
#define SDA_PIN             8   // ESP32-C3 I2C SDA
#define SCL_PIN             9   // ESP32-C3 I2C SCL

// --- LED配置 ---
#define LED_PIN             10  // ESP32-C3内置LED（如果GPIO10不可用，尝试GPIO8）

// --- 数据过滤参数 ---
// 注意：已取消最小距离限制，避免TOF传感器20mm误差导致的频繁跳变
// 只过滤超出最大范围的值，所有0-2000mm范围内的读数都会发送
#define FILTER_MAX_MM       2000 // 超过这个距离视为无效

// --- 方向映射 ---
const char* DIR_NAMES[8] = {
  "Left",         // 0
  "BackLeft",    // 1
  "FrontLeft",   // 2
  "Front",        // 3
  "Back",         // 4
  "BackRight",   // 5
  "FrontRight",  // 6
  "Right"         // 7
};

// --- 全局变量 ---
unsigned long lastSendTime = 0;
unsigned long currentSendInterval = 300; // 当前发送间隔（动态调整）
const unsigned long BASE_SEND_INTERVAL = 300; // 基础发送间隔300ms
const unsigned long MAX_SEND_INTERVAL = 1000; // 最大发送间隔1000ms（缓冲区满时延长）
bool sensorInitialized[8] = {false, false, false, false, false, false, false, false};

// --- BLE 全局变量 ---
NimBLEServer* pServer = nullptr;
NimBLECharacteristic* pCharacteristic = nullptr;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// --- BLE 回调类 ---
class MyServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) {
        deviceConnected = true;
        Serial.println("BLE: 设备已连接");
        Serial.print("BLE: 客户端地址: ");
        Serial.println(connInfo.getAddress().toString().c_str());

        // 连接成功后开始发送数据
        NimBLEDevice::startAdvertising();
    };

    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) {
        deviceConnected = false;
        Serial.println("BLE: 设备已断开连接");
        Serial.print("BLE: 断开原因: ");
        Serial.println(reason);

        // 断开连接后重新开始广播
        NimBLEDevice::startAdvertising();
    };
};

class MyCharacteristicCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) {
        Serial.println("BLE: 特征值被读取");
    };

    void onStatus(NimBLECharacteristic* pCharacteristic, int code) {
        Serial.printf("BLE: 通知状态改变 - 代码: %d\n", code);
    };
};

// --- 1. TCA9548A控制函数 ---
/**
 * 选择TCA9548A的通道
 * @param channel 通道号 (0-7)
 */
void tcaSelect(uint8_t channel) {
  if (channel > 7) return;
  Wire.beginTransmission(TCA9548A_ADDR);
  Wire.write(1 << channel);
  Wire.endTransmission();
}

// --- 2. 读取TOF传感器数据函数 ---
/**
 * 读取所有TOF传感器的距离数据
 * @param distances 输出数组，存储8个方向的距离值
 * @param minDir 输出参数，最小距离的方向索引
 * @param minDist 输出参数，最小距离值
 * @return 是否至少有一个传感器读取成功
 */
bool readTOFSensors(uint16_t* distances, int* minDir, uint16_t* minDist) {
  uint16_t minDistance = FILTER_MAX_MM;
  int minDirection = -1;
  bool anySuccess = false;

  for (int i = 0; i < NUM_SENSORS; i++) {
    if (!sensorInitialized[i]) {
      distances[i] = FILTER_MAX_MM;
      continue;
    }

    // 选择TCA9548A通道
    tcaSelect(i);
    delay(2);

    // 读取距离数据
    uint16_t distance = sensors[i].read();
    distances[i] = distance;

    // 检查数据有效性（只检查最大值，不检查最小值，避免20mm误差导致的频繁跳变）
    // 0值通常表示传感器错误或超出范围，但我们也发送真实值
    if (distance > 0 && distance <= FILTER_MAX_MM) {
      anySuccess = true;
      if (distance < minDistance) {
        minDistance = distance;
        minDirection = i;
    }
  } else {
      // 超出范围或为0，设置为无效值
      distances[i] = FILTER_MAX_MM;
  }
}

  *minDir = minDirection;
  *minDist = (minDirection >= 0) ? minDistance : FILTER_MAX_MM;

  return anySuccess;
}

// --- 3. 初始化TOF传感器 ---
/**
 * 初始化所有8个TOF传感器
 * @return 是否至少有一个传感器初始化成功
 */
bool initTOFSensors() {
  Serial.println(F("TOF: Initializing 8 sensors..."));

  // 测试TCA9548A
  Wire.beginTransmission(TCA9548A_ADDR);
  byte error = Wire.endTransmission();
  if (error != 0) {
    Serial.print(F("ERROR: TCA9548A not found at 0x"));
    Serial.println(TCA9548A_ADDR, HEX);
    return false;
  }
  Serial.println(F("TCA9548A OK"));

  int successCount = 0;
  for (int i = 0; i < NUM_SENSORS; i++) {
    Serial.print(F("TOF Sensor "));
    Serial.print(i);
    Serial.print(F(" ("));
    Serial.print(DIR_NAMES[i]);
    Serial.print(F(")..."));

    // 选择TCA9548A通道
    tcaSelect(i);
    delay(20);

    // 初始化传感器
    unsigned long initStart = millis();
    bool initSuccess = false;

    while (millis() - initStart < 2000) {
      if (sensors[i].init()) {
        initSuccess = true;
        break;
      }
      delay(50);
    }

    if (!initSuccess) {
      Serial.print(F("WARN: Sensor "));
      Serial.print(i);
      Serial.print(F(" ("));
      Serial.print(DIR_NAMES[i]);
      Serial.println(F(") timeout"));
      continue;
    }

    // 设置测量模式
    sensors[i].setDistanceMode(VL53L1X::Short);
    sensors[i].setMeasurementTimingBudget(20000);
    sensors[i].startContinuous(50);

    Serial.print(F("OK: Sensor "));
    Serial.print(i);
    Serial.print(F(" ("));
    Serial.print(DIR_NAMES[i]);
    Serial.println(F(")"));
    sensorInitialized[i] = true;
    successCount++;
    delay(30);
  }

  Serial.print(successCount);
  Serial.print(F("/"));
  Serial.print(NUM_SENSORS);
  Serial.println(F(" sensors OK"));

  if (successCount == 0) {
    Serial.println(F("ERROR: No sensors initialized!"));
    return false;
  }

  return true;
}

// --- 4. 初始化BLE ---
/**
 * 初始化BLE服务和特性
 */
void initBLE() {
  Serial.println(F("BLE: Initializing NimBLE..."));

  // 初始化NimBLE设备
  NimBLEDevice::init(DEVICE_NAME);

  // 设置BLE设备参数
  NimBLEDevice::setPower(ESP_PWR_LVL_P9); // 设置发射功率
  NimBLEDevice::setSecurityAuth(false, false, false); // 禁用安全认证，简化连接

  // 创建BLE服务器
  pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // 创建BLE服务
  NimBLEService* pService = pServer->createService(SERVICE_UUID);

  // 创建BLE特征
  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );

  // 设置特征回调
  pCharacteristic->setCallbacks(new MyCharacteristicCallbacks());

  // 设置初始值（23字节的0值）
  uint8_t initialValue[23] = {0};
  pCharacteristic->setValue(initialValue, 23);

  // 启动服务
  pService->start();

  // 开始广播
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);

  NimBLEDevice::startAdvertising();

  Serial.println(F("BLE: Advertising started"));
  Serial.print(F("BLE: Service UUID: "));
  Serial.println(SERVICE_UUID);
  Serial.print(F("BLE: Characteristic UUID: "));
  Serial.println(CHARACTERISTIC_UUID);
}

// --- 5. 发送BLE数据 ---
/**
 * 读取传感器数据并通过BLE Notify发送
 * 数据格式: [时间戳(4字节)] [最小方向(1字节)] [最小距离(2字节)] [8方向距离(16字节)]
 * 总长度: 23字节
 */
void sendBLEData() {
  uint16_t distances[8];
  int currentMinDir;
  uint16_t currentMinDist;
  bool readSuccess = false;

  // 读取TOF传感器数据（如果传感器已初始化）
  bool hasInitializedSensors = false;
  for (int i = 0; i < NUM_SENSORS; i++) {
    if (sensorInitialized[i]) {
      hasInitializedSensors = true;
      break;
    }
  }

  if (hasInitializedSensors) {
    readSuccess = readTOFSensors(distances, &currentMinDir, &currentMinDist);
  } else {
    // 如果没有传感器，发送测试数据
  for (int i = 0; i < 8; i++) {
      distances[i] = 500 + i * 50; // 测试数据：500, 550, 600...
    }
    currentMinDir = 0;
    currentMinDist = 500;
    readSuccess = true;
    Serial.println(F("BLE: Using test data (no sensors)"));
  }

  // 构造二进制数据包
  // 格式: [时间戳(4字节)] [最小方向(1字节)] [最小距离(2字节)] [8方向距离(16字节)]
  uint32_t timestamp = millis();
  uint8_t dataPacket[23]; // 4 + 1 + 2 + 16 = 23字节

  // 时间戳 (小端序)
  memcpy(&dataPacket[0], &timestamp, 4);

  // 最小方向 (如果无效则为255)
  dataPacket[4] = (uint8_t)(currentMinDir >= 0 ? currentMinDir : 255);

  // 最小距离 (小端序)
  memcpy(&dataPacket[5], &currentMinDist, 2);

  // 8方向距离 (小端序)
  for (int i = 0; i < 8; i++) {
    memcpy(&dataPacket[7 + i * 2], &distances[i], 2);
  }

  // 只有在有客户端连接时才发送数据
  if (deviceConnected && pCharacteristic) {
    // 发送BLE通知
    pCharacteristic->setValue(dataPacket, sizeof(dataPacket));
    pCharacteristic->notify();

    // 调试输出到USB串口
    Serial.print(F("BLE: "));
    Serial.print(sizeof(dataPacket));
    Serial.print(F("B Dir:"));
    if (currentMinDir >= 0 && currentMinDir < 8) {
      Serial.print(currentMinDir);
      Serial.print(F("("));
      Serial.print(DIR_NAMES[currentMinDir]);
      Serial.print(F(")"));
    } else {
      Serial.print(F("N/A"));
    }
    Serial.print(F(" Dist:"));
    Serial.print(currentMinDist);
    Serial.println(readSuccess ? F(" OK") : F(" ERR"));
  } else {
    // 没有客户端连接时的调试输出
    static unsigned long lastNoClientLog = 0;
    if (millis() - lastNoClientLog > 5000) { // 每5秒输出一次
      Serial.println(F("BLE: No client connected, skipping data send"));
      lastNoClientLog = millis();
    }
  }

  // 每10次发送显示一次状态
  static int sendCount = 0;
  sendCount++;
  if (sendCount % 10 == 0) {
    Serial.print(F("BLE: Sent "));
    Serial.print(sendCount);
    Serial.print(F(", Connected: "));
    Serial.println(deviceConnected ? F("Yes") : F("No"));
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
  Serial.println(F("SEBT Host BLE (ESP32-C3) - Starting..."));
  Serial.println(F("========================================"));
  Serial.println(F("Serial Monitor Test - If you see this, serial is working!"));
  Serial.println(F("Baud Rate: 115200"));
  Serial.println(F("Line Ending: Both NL & CR"));
  Serial.println(F("========================================"));
  Serial.println();
  Serial.println(F("NimBLE-Arduino Library: https://github.com/h2zero/NimBLE-Arduino"));
  Serial.println();

  Serial.println(F("Step 1: Serial initialized"));

  // 初始化LED
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.println(F("LED: Initialized"));

  // 初始化传感器状态数组
  for (int i = 0; i < NUM_SENSORS; i++) {
    sensorInitialized[i] = false;
  }

  // 初始化I2C
  Serial.println(F("Step 2: Initializing I2C..."));
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000); // 100kHz时钟频率
  delay(100);
  Serial.println(F("Step 2: I2C initialized"));
  Serial.printf("I2C: SDA pin %d, SCL pin %d\n", SDA_PIN, SCL_PIN);

  // 初始化TOF传感器
  Serial.println(F("Step 3: Initializing TOF sensors..."));
  bool tofOk = initTOFSensors();

  if (!tofOk) {
    Serial.println(F("WARN: Some TOF sensors failed"));
    Serial.println(F("Continuing with available sensors..."));
  } else {
    Serial.println(F("Step 3: TOF sensors initialized"));
  }

  delay(500);

  // 初始化BLE
  Serial.println(F("Step 4: Initializing BLE..."));
  initBLE();
  Serial.println(F("Step 4: BLE initialized"));

  // 初始化完成
  Serial.println(F("========================================"));
  Serial.println(F("SEBT BLE Host - Ready!"));
  Serial.println(F("Waiting for BLE client connection..."));
  Serial.println(F("========================================"));
}

void loop() {
  // 定时发送数据（使用动态调整的发送间隔）
  if (millis() - lastSendTime >= currentSendInterval) {
    sendBLEData();
    lastSendTime = millis();

    // LED闪烁指示数据发送（非阻塞方式）
    digitalWrite(LED_PIN, HIGH);
    // 移除delay，避免阻塞主循环
    // delay(10); // 已移除，LED闪烁由心跳控制
    digitalWrite(LED_PIN, LOW);
  }

  // 处理BLE连接状态变化
  if (deviceConnected != oldDeviceConnected) {
    if (deviceConnected) {
      Serial.println(F("BLE: Client connected, starting data transmission"));
    } else {
      Serial.println(F("BLE: Client disconnected, restarting advertising"));
    }
    oldDeviceConnected = deviceConnected;
  }

  // LED心跳闪烁（每秒一次）
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat >= 1000) {
    digitalWrite(LED_PIN, HIGH);
    delay(50);
    digitalWrite(LED_PIN, LOW);
    lastHeartbeat = millis();

    // 每5秒输出一次状态
    static int statusCount = 0;
    statusCount++;
    if (statusCount >= 5) {
      Serial.print(F("Status: Running, Uptime: "));
      Serial.print(millis() / 1000);
      Serial.print(F("s, Connected: "));
      Serial.println(deviceConnected ? F("Yes") : F("No"));
      statusCount = 0;
    }
  }

  // 让BLE库处理事件
  delay(10); // 简单的延时替代handleConnections
}