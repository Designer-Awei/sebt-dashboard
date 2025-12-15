/*
 * SEBT Host Hardware Test (BLE Version)
 * 硬件：ESP32-C3, TCA9548A, 8x VL53L1X, SH1106 OLED
 * 功能：BLE通信 + 距离测量 + 3秒锁定
 * 参考：原始代码.ino
 */

#include <Wire.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <Adafruit_VL53L1X.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// --- 1. 引脚定义 ---
#define SDA_PIN 8
#define SCL_PIN 9
#define MUX_ADDR 0x70

// RGB LED (共阴, 高电平亮)
#define PIN_LED_R 5
#define PIN_LED_G 6
#define PIN_LED_B 7

// 按键 (低电平触发)
#define PIN_BTN 2

// OLED 设置
#define SCREEN_ADDRESS 0x3C
Adafruit_SH1106G display = Adafruit_SH1106G(128, 64, &Wire, -1);

// ToF 传感器对象
Adafruit_VL53L1X vl53 = Adafruit_VL53L1X();

// --- 2. BLE配置 ---
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define SCAN_DATA_CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define LOCK_DATA_CHAR_UUID "1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e"
#define COMMAND_CHAR_UUID   "d2b86f7a-1b6d-4e7c-8f2a-9b8c5f3e1d2a"

BLEServer* pServer = NULL;
BLECharacteristic* pScanDataCharacteristic = NULL;
BLECharacteristic* pLockDataCharacteristic = NULL;
BLECharacteristic* pCommandCharacteristic = NULL;

bool deviceConnected = false;
bool oldDeviceConnected = false;

// LED状态控制
bool ledNeedsUpdate = false;
bool ledStateR = true;  // 默认红灯
bool ledStateG = false;
bool ledStateB = false;

// --- 3. 逻辑参数 ---
const int STABLE_TIME_MS = 3000;  // 锁定时间3秒
const int FILTER_MAX_MM = 2000;   // 超过这个距离忽略
const int FILTER_MIN_MM = 30;     // 小于这个距离忽略(噪音)

// --- 4. 方向映射 ---
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

// --- 5. 全局变量 ---
int distances[8];
int minIndex = -1;
int minDistance = 9999;

// 状态控制
bool isLocked = false;
int lastCandidateIndex = -1;
unsigned long stableStartTime = 0;

// 已完成测距的方向 (true表示已完成)
bool completedDirections[8] = {false, false, false, false, false, false, false, false};

// BLE数据发送控制
unsigned long lastBleSendTime = 0;
const unsigned long BLE_SEND_INTERVAL = 500; // 500ms发送一次

// --- BLE回调类 ---
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      Serial.println("BLE: Device connected");
      // 设置LED为绿灯
      ledStateR = false;
      ledStateG = true;
      ledStateB = false;
      ledNeedsUpdate = true;
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      Serial.println("BLE: Device disconnected");
      // 设置LED为红灯
      ledStateR = true;
      ledStateG = false;
      ledStateB = false;
      ledNeedsUpdate = true;
    }
};

class MyCommandCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue();

      if (rxValue.length() > 0) {
        Serial.printf("BLE: Received command: %s\n", rxValue.c_str());

        // 解析命令
        if (rxValue.indexOf("RESET") != -1) {
          // 复位命令 - 重置锁定状态和已完成方向
          isLocked = false;
          lastCandidateIndex = -1;
          // 重置所有方向的完成状态
          for (int i = 0; i < 8; i++) {
            completedDirections[i] = false;
          }
          Serial.println("BLE: Reset command received - 重置所有状态");

          display.clearDisplay();
          display.setCursor(0, 20);
          display.setTextSize(2);
          display.println("BLE RESET...");
          display.display();
          delay(500);

        } else if (rxValue.indexOf("STATUS") != -1) {
          // 状态查询命令
          Serial.println("BLE: Status query received");
        } else if (rxValue.startsWith("MEASURE:")) {
          // 测距完成命令 - 格式: MEASURE:方向索引
          int completedDirection = rxValue.substring(rxValue.indexOf(":") + 1).toInt();
          if (completedDirection >= 0 && completedDirection < 8) {
            // 标记该方向为已完成测距
            completedDirections[completedDirection] = true;
            Serial.printf("BLE: 测距完成 - 方向%d (%s) 已标记为完成\n",
                         completedDirection, DIR_NAMES[completedDirection]);

            // 如果当前是锁定状态，重置锁定状态回到实时检测
            if (isLocked) {
              isLocked = false;
              lastCandidateIndex = -1;
              Serial.println("BLE: 测距完成，重置锁定状态，回到实时检测模式");
            }
          } else {
            Serial.printf("BLE: 无效的测距完成命令: %s\n", rxValue.c_str());
          }
        }
      }
    }
};

// --- 辅助函数：切换Mux通道 ---
void tcaSelect(uint8_t i) {
  if (i > 7) return;
  Wire.beginTransmission(MUX_ADDR);
  Wire.write(1 << i);
  Wire.endTransmission();
}

// --- 辅助函数：I2C总线扫描 ---
void scanI2CBus() {
  Serial.println("I2C: Scanning bus...");

  int deviceCount = 0;
  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    uint8_t error = Wire.endTransmission();

    if (error == 0) {
      Serial.printf("I2C: Device found at 0x%02X\n", address);
      deviceCount++;

      // 特别标记已知设备
      if (address == MUX_ADDR) {
        Serial.println("I2C: -> TCA9548A Mux");
      } else if (address == SCREEN_ADDRESS) {
        Serial.println("I2C: -> OLED Display");
      }
    } else if (error == 4) {
      Serial.printf("I2C: Unknown error at 0x%02X\n", address);
    }
  }

  Serial.printf("I2C: Scan complete, found %d devices\n", deviceCount);

  // 检查TCA9548A多路复用器
  Serial.println("I2C: Testing TCA9548A mux...");
  Wire.beginTransmission(MUX_ADDR);
  uint8_t muxError = Wire.endTransmission();
  if (muxError == 0) {
    Serial.println("I2C: TCA9548A responsive");

    // 测试每个通道
    for (int ch = 0; ch < 8; ch++) {
      tcaSelect(ch);
      delay(10); // 等待切换

      // 在每个通道上扫描VL53L1X (默认地址0x29)
      Wire.beginTransmission(0x29);
      uint8_t sensorError = Wire.endTransmission();

      if (sensorError == 0) {
        Serial.printf("I2C: Sensor on channel %d: OK\n", ch);
      } else {
        Serial.printf("I2C: Sensor on channel %d: FAIL (error %d)\n", ch, sensorError);
      }
    }
  } else {
    Serial.printf("I2C: TCA9548A not responding (error %d)\n", muxError);
  }
}

// --- 辅助函数：设置RGB ---
void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_LED_R, r);
  digitalWrite(PIN_LED_G, g);
  digitalWrite(PIN_LED_B, b);
}

// --- BLE初始化 ---
void initBLE() {
  Serial.println("BLE: Initializing BLE...");

  // 生成唯一的设备名称后缀 (使用芯片ID的后4位)
  uint32_t chipId = ESP.getEfuseMac();
  String suffix = String((chipId >> 16) & 0xFFFF, HEX); // 使用MAC地址的高16位，避免全0
  suffix.toUpperCase();
  String deviceName = "SEBT-Host-" + suffix;

  Serial.print("BLE: Device name: ");
  Serial.println(deviceName);
  BLEDevice::init(deviceName.c_str());
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // 创建服务
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // 扫描数据特征 (实时距离数据)
  pScanDataCharacteristic = pService->createCharacteristic(
    SCAN_DATA_CHAR_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pScanDataCharacteristic->addDescriptor(new BLE2902());

  // 锁定数据特征 (锁定事件)
  pLockDataCharacteristic = pService->createCharacteristic(
    LOCK_DATA_CHAR_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pLockDataCharacteristic->addDescriptor(new BLE2902());

  // 命令特征 (接收PC指令)
  pCommandCharacteristic = pService->createCharacteristic(
    COMMAND_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pCommandCharacteristic->setCallbacks(new MyCommandCallbacks());

  // 启动服务
  pService->start();

  // 启动广播
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("BLE: Advertising started");
}

// --- 发送实时扫描数据 ---
void sendRealtimeData(int directionIndex, int distance, bool isMinDistance) {
  if (!deviceConnected) {
    Serial.println("BLE: Not connected, skip sending data");
    return;
  }

  // 如果没有有效的距离数据，使用默认值
  int sendDirectionIndex = directionIndex;
  int sendDistance = distance;

  if (directionIndex == -1 || distance == 9999) {
    // 使用第一个传感器的距离作为默认值，即使是无效的也要发送
    sendDirectionIndex = 0;
    sendDistance = distances[0];
    Serial.println("BLE: No valid distance data, sending default values");
  }

  // 构建包含8方向完整距离数据的JSON格式
  String jsonData = "{";
  jsonData += "\"distances\":[";

  // 发送所有8个方向的距离数据
  for (int i = 0; i < 8; i++) {
    jsonData += "[" + String(i) + "," + String(distances[i]) + "]";
    if (i < 7) jsonData += ",";
  }

  jsonData += "],";
  jsonData += "\"minDir\":" + String(sendDirectionIndex) + ",";
  jsonData += "\"minDist\":" + String(sendDistance) + ",";
  jsonData += "\"timestamp\":" + String(millis());
  jsonData += "}";

  Serial.printf("BLE: SENDING scan data - dir:%d, dist:%dmm, data length:%d\n",
                sendDirectionIndex, sendDistance, jsonData.length());
  Serial.println("BLE: Full JSON data:");
  Serial.println(jsonData);

  pScanDataCharacteristic->setValue(jsonData.c_str());
  pScanDataCharacteristic->notify();

  Serial.println("BLE: Data sent successfully via BLE");
}

// --- 发送锁定数据 ---
void sendLockData(int directionIndex, int distance) {
  if (!deviceConnected) return;

  // 构建JSON格式数据
  String jsonData = "{";
  jsonData += "\"locked\":true,";
  jsonData += "\"direction\":" + String(directionIndex) + ",";
  jsonData += "\"directionName\":\"" + String(DIR_NAMES[directionIndex]) + "\",";
  jsonData += "\"distance\":" + String(distance) + ",";
  jsonData += "\"timestamp\":" + String(millis());
  jsonData += "}";

  pLockDataCharacteristic->setValue(jsonData.c_str());
  pLockDataCharacteristic->notify();

  Serial.printf("BLE: Sent lock data - dir:%d, dist:%dmm\n", directionIndex, distance);
}

void setup() {
  // ESP32-C3串口引脚配置 (如果需要的话)
  // Serial.begin(115200, SERIAL_8N1, 20, 21); // RX=20, TX=21 (ESP32-C3默认)
  Serial.begin(115200);
  delay(100); // 等待串口初始化

  Serial.println("=== SEBT Host BLE v1.0 Starting ===");
  Serial.printf("ESP32 Chip ID: %08X\n", ESP.getEfuseMac());
  Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
  Serial.printf("SDK Version: %s\n", ESP.getSdkVersion());

  // 初始化引脚
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);

  // 初始化LED状态 (红灯亮)
  ledStateR = true;
  ledStateG = false;
  ledStateB = false;
  setRGB(ledStateR, ledStateG, ledStateB);

  // I2C初始化 - 使用较低的时钟频率以提高稳定性
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000); // 100kHz时钟频率

  // I2C总线诊断
  Serial.println("I2C: Bus initialized");
  Serial.printf("I2C: SDA pin %d, SCL pin %d\n", SDA_PIN, SCL_PIN);
  Serial.printf("I2C: Clock frequency %d Hz\n", Wire.getClock());

  // 执行I2C总线快速扫描 (只扫描已知设备)
  Serial.println("I2C: Quick scan starting...");

  // 检查TCA9548A多路复用器
  Wire.beginTransmission(MUX_ADDR);
  uint8_t muxError = Wire.endTransmission();
  if (muxError == 0) {
    Serial.println("I2C: TCA9548A found at 0x70");
  } else {
    Serial.printf("I2C: TCA9548A not found (error %d)\n", muxError);
  }

  // 检查OLED
  Wire.beginTransmission(SCREEN_ADDRESS);
  uint8_t oledError = Wire.endTransmission();
  if (oledError == 0) {
    Serial.println("I2C: OLED found at 0x3C");
  } else {
    Serial.printf("I2C: OLED not found (error %d)\n", oledError);
  }

  Serial.println("I2C: Quick scan complete");

  // OLED 初始化
  if (!display.begin(SCREEN_ADDRESS, true)) {
    Serial.println("OLED init failed");
    for(int i=0; i<5; i++) {
      setRGB(0,0,0); delay(100);
      setRGB(1,0,0); delay(100);
    }
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SH110X_WHITE);
  display.setCursor(0,0);
  display.println("SEBT Host BLE v1.0");
  display.println("System Booting...");
  display.display();
  delay(1000);

  // BLE初始化
  display.println("Init BLE...");
  display.display();
  initBLE();
  delay(500);

  // 传感器初始化
  display.println("Init Sensors...");
  display.display();

  for (int i = 0; i < 8; i++) {
    tcaSelect(i);
    display.printf("S%d: ", i);

    if (!vl53.begin(0x29, &Wire)) {
      display.println("FAIL");
      Serial.printf("Sensor %d init failed\n", i);
    } else {
      vl53.startRanging();
      vl53.setTimingBudget(50); // 高速模式
      display.println("OK");
      Serial.printf("Sensor %d ready\n", i);
    }
    display.display();
    delay(100);
  }

  display.println("Ready!");
  display.display();
  delay(1000);
}

void loop() {
  // 基本心跳输出
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat > 2000) { // 每2秒输出一次心跳
    Serial.printf("Heartbeat: %lu ms, BLE:%s\n", millis(), deviceConnected ? "connected" : "disconnected");
    lastHeartbeat = millis();
  }

  // --- LED状态更新 ---
  if (ledNeedsUpdate) {
    setRGB(ledStateR, ledStateG, ledStateB);
    ledNeedsUpdate = false;
  }

  // --- BLE连接状态管理 ---
  if (!deviceConnected && oldDeviceConnected) {
    delay(500); // 给蓝牙栈时间处理断开
    pServer->startAdvertising(); // 重新开始广播
    Serial.println("BLE: Restart advertising");
    oldDeviceConnected = deviceConnected;
  }

  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  // --- 1. 按钮复位逻辑 ---
  if (digitalRead(PIN_BTN) == LOW) {
    isLocked = false;
    lastCandidateIndex = -1;
    // 设置LED为红灯
    ledStateR = true;
    ledStateG = false;
    ledStateB = false;
    ledNeedsUpdate = true;
    display.clearDisplay();
    display.setCursor(0, 20);
    display.setTextSize(2);
    display.println("RESET...");
    display.display();
    delay(500);
    return;
  }

  // --- 2. 扫描所有传感器 ---
  minDistance = 9999;
  minIndex = -1;
  bool i2cError = false;

  for (int i = 0; i < 8; i++) {
    // I2C总线健康检查
    Wire.beginTransmission(MUX_ADDR);
    uint8_t muxError = Wire.endTransmission();

    if (muxError != 0) {
      i2cError = true;
      Serial.printf("I2C: Mux error on channel %d (error %d)\n", i, muxError);
      distances[i] = 9999; // 设置为无效值
      continue;
    }

    tcaSelect(i);

    // 传感器通信超时保护
    unsigned long sensorStartTime = millis();
    bool sensorReady = false;

    while (millis() - sensorStartTime < 50) { // 50ms超时
      if (vl53.dataReady()) {
        sensorReady = true;
        break;
      }
      delay(1);
    }

    if (sensorReady) {
      int d = vl53.distance();
      if (d == -1) d = 9999;
      distances[i] = d;
      vl53.clearInterrupt();

      // 计算最小距离用于数据发送（始终计算，不受完成状态影响）
      if (distances[i] > FILTER_MIN_MM && distances[i] < FILTER_MAX_MM) {
        if (distances[i] < minDistance) {
          minDistance = distances[i];
          minIndex = i;
        }
      }

      Serial.printf("Sensor %d: %dmm\n", i, distances[i]);
    } else {
      Serial.printf("Sensor %d: timeout/no data\n", i);
      distances[i] = 9999; // 超时设置为无效值
    }
  }

  // I2C故障诊断
  if (i2cError) {
    Serial.println("I2C: Bus fault detected - entering degraded mode");
    // 在降级模式下，使用模拟数据确保BLE仍能发送
    if (minIndex == -1) {
      minIndex = 0;
      minDistance = 1000; // 默认1米距离
      distances[0] = 1000;
      Serial.println("BLE: Using degraded mode data for transmission");
    }
  }

  // --- 3. BLE数据发送 (连接状态下始终发送) ---
  if (deviceConnected && millis() - lastBleSendTime >= BLE_SEND_INTERVAL) {
    // 连接状态下始终发送数据，即使没有有效的距离读数也要发送（用于心跳检测）
    sendRealtimeData(minIndex, minDistance, !isLocked); // isMinDistance = !isLocked
    lastBleSendTime = millis();
  }

  // --- 4. 锁定判断逻辑 ---
  if (!isLocked) {
    // 根据BLE连接状态设置LED
    if (deviceConnected) {
      // 红灯 (扫描中，已连接BLE)
      ledStateR = true;
      ledStateG = false;
      ledStateB = false;
      ledNeedsUpdate = true;
    } else {
      // 黄灯 (等待BLE连接)
      ledStateR = true;
      ledStateG = true;
      ledStateB = false;
      ledNeedsUpdate = true;
    }

    if (minIndex != -1) {
      if (minIndex == lastCandidateIndex) {
        if (millis() - stableStartTime > STABLE_TIME_MS) {
          isLocked = true;
          // 蓝灯 (锁定!)
          ledStateR = false;
          ledStateG = false;
          ledStateB = true;
          ledNeedsUpdate = true;

          // 发送锁定数据到BLE
          if (deviceConnected) {
            sendLockData(lastCandidateIndex, distances[lastCandidateIndex]);
          }
        }
      } else {
        lastCandidateIndex = minIndex;
        stableStartTime = millis();
      }
    } else {
      lastCandidateIndex = -1;
    }
  }

  // --- 5. OLED 显示逻辑 ---
  display.clearDisplay();

  if (isLocked) {
    // === 锁定状态 ===
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println(DIR_NAMES[lastCandidateIndex]);

    display.setTextSize(3);
    display.setCursor(0, 25);
    display.print(distances[lastCandidateIndex]);
    display.setTextSize(1);
    display.print(" mm");

    // 显示BLE状态
    display.setCursor(80, 0);
    display.setTextSize(1);
    if (deviceConnected) {
      display.println("BLE:PC");
    } else {
      display.println("BLE:--");
    }

  } else {
    // === 扫描状态 ===
    // 左上角显示已完成方向数量
    int completedCount = 0;
    for (int i = 0; i < 8; i++) {
      if (completedDirections[i]) completedCount++;
    }
    display.setCursor(0, 0);
    display.setTextSize(1);
    display.printf("Done: %d/8", completedCount);

    if (minIndex != -1) {
      display.setCursor(0, 15);
      display.print("Nearest: ");
      display.println(DIR_NAMES[minIndex]);

      display.setCursor(0, 30);
      display.setTextSize(2);
      display.print(minDistance);
      display.print(" mm");

      // 显示进度条
      if (lastCandidateIndex != -1 && minIndex == lastCandidateIndex) {
        long elapsed = millis() - stableStartTime;
        int barWidth = map(elapsed, 0, STABLE_TIME_MS, 0, 128);
        if (barWidth > 128) barWidth = 128;

        display.drawRect(0, 55, 128, 6, SH110X_WHITE);
        display.fillRect(0, 55, barWidth, 6, SH110X_WHITE);
      }
    } else {
      display.setCursor(0, 25);
      display.println("No Object");
    }

    // 显示BLE状态在右上角
    display.setCursor(80, 0);
    display.setTextSize(1);
    if (deviceConnected) {
      display.println("BLE:PC");
    } else {
      display.println("BLE:--");
    }
  }

  display.display(); // 刷新屏幕
}
