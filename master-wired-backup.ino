/*
 * SEBT Host - 有线保底方案 (USB串口 + BLE)
 * 硬件：ESP32-C3, TCA9548A, 8x VL53L1X, SH1106 OLED
 * 通信：USB串口(与PC) + BLE(与从机)
 * 功能：距离测量 + 3秒锁定 + 有线数据传输
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

// --- 1. 硬件引脚定义 ---
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
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// --- 3. 通信协议定义 ---
// 数据包格式: [TYPE][LENGTH][DATA...][CHECKSUM]
#define PACKET_TYPE_SENSOR_DATA 0x01
#define PACKET_TYPE_STATUS      0x02
#define PACKET_TYPE_COMMAND     0x03

// --- 4. 逻辑参数 ---
const int STABLE_TIME_MS = 3000;  // 锁定时间3秒
const int FILTER_MAX_MM = 2000;   // 超过这个距离忽略
const int FILTER_MIN_MM = 30;     // 小于这个距离忽略

// --- 5. 方向映射 ---
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

// --- 6. 全局变量 ---
int distances[8];
int minIndex = -1;
int minDistance = 9999;

// 状态控制
bool isLocked = false;
int lastCandidateIndex = -1;
unsigned long stableStartTime = 0;

// BLE数据缓冲区
String bleDataBuffer = "";

// --- 辅助函数：切换Mux通道 ---
void tcaSelect(uint8_t i) {
  if (i > 7) return;
  Wire.beginTransmission(MUX_ADDR);
  Wire.write(1 << i);
  Wire.endTransmission();
}

// --- 辅助函数：设置RGB ---
void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_LED_R, r);
  digitalWrite(PIN_LED_G, g);
  digitalWrite(PIN_LED_B, b);
}

// --- BLE服务器回调类 ---
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      Serial.println("BLE device connected");
      setRGB(0, 1, 0); // 绿灯表示BLE连接
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      Serial.println("BLE device disconnected");
      setRGB(1, 0, 0); // 红灯表示BLE断开
    }
};

// --- BLE特征回调类 ---
class MyCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      std::string rxValue = pCharacteristic->getValue();

      if (rxValue.length() > 0) {
        // 接收到BLE数据，转发给PC
        Serial.print("BLE>");
        Serial.println(rxValue.c_str());

        // 解析数据包
        if (rxValue.length() >= 3) {
          uint8_t packetType = rxValue[0];
          uint8_t dataLength = rxValue[1];

          if (packetType == PACKET_TYPE_SENSOR_DATA && dataLength > 0) {
            // 处理从机传感器数据
            Serial.printf("Received sensor data from slave: %d bytes\n", dataLength);
            // 这里可以添加数据处理逻辑
          }
        }
      }
    }
};

// --- BLE初始化 ---
void initBLE() {
  Serial.println("Initializing BLE...");

  BLEDevice::init("SEBT-Host");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ |
                      BLECharacteristic::PROPERTY_WRITE |
                      BLECharacteristic::PROPERTY_NOTIFY
                    );

  pCharacteristic->setCallbacks(new MyCallbacks());
  pCharacteristic->addDescriptor(new BLE2902());

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(false);
  pAdvertising->setMinPreferred(0x0);
  BLEDevice::startAdvertising();

  Serial.println("BLE server started, waiting for slave connection...");
}

// --- 数据打包函数 ---
void sendPacketToPC(uint8_t packetType, const String& data) {
  uint8_t length = data.length();
  uint8_t checksum = packetType ^ length;

  for (char c : data) {
    checksum ^= (uint8_t)c;
  }

  // 发送数据包: [TYPE][LENGTH][DATA...][CHECKSUM]
  Serial.write(packetType);
  Serial.write(length);
  Serial.print(data);
  Serial.write(checksum);
  Serial.println(); // 包结束
}

// --- 发送传感器数据到PC ---
void sendSensorDataToPC(int directionIndex, int distance) {
  String data = "{";
  data += "\"direction\":" + String(directionIndex) + ",";
  data += "\"directionName\":\"" + String(DIR_NAMES[directionIndex]) + "\",";
  data += "\"distance\":" + String(distance) + ",";
  data += "\"timestamp\":" + String(millis()) + ",";
  data += "\"locked\":" + (isLocked ? "true" : "false");
  data += "}";

  sendPacketToPC(PACKET_TYPE_SENSOR_DATA, data);
}

// --- 发送状态数据到PC ---
void sendStatusToPC(const String& status) {
  sendPacketToPC(PACKET_TYPE_STATUS, status);
}

// --- 处理来自PC的命令 ---
void processPCCommand() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command.length() > 0) {
      Serial.print("PC>");
      Serial.println(command);

      // 检查是否是手动测距命令
      if (command.startsWith("PC>MEASURE:")) {
        int channel = command.substring(11).toInt(); // 提取通道号
        performManualMeasurement(channel);
        return;
      }

      // 其他命令转发给BLE从机
      if (deviceConnected && pCharacteristic != NULL) {
        pCharacteristic->setValue(command.c_str());
        pCharacteristic->notify();
        Serial.println("Command forwarded to BLE slave");
      } else {
        Serial.println("BLE slave not connected, command ignored");
      }
    }
  }
}

// --- 执行手动测距 ---
void performManualMeasurement(int channel) {
  Serial.printf("Manual measurement requested for channel %d\n", channel);

  // 切换到指定通道
  tcaSelect(channel);

  // 等待传感器准备
  delay(50);

  // 读取距离数据
  if (vl53.dataReady()) {
    int distance = vl53.distance();
    vl53.clearInterrupt();

    if (distance == -1) distance = 9999; // 处理无效数据

    // 发送测距结果到PC
    sendSensorDataToPC(channel, distance);

    Serial.printf("Manual measurement result: channel %d = %d mm\n", channel, distance);

    // OLED显示测距结果（临时显示）
    display.clearDisplay();
    display.setCursor(0, 0);
    display.printf("Manual Measure");
    display.setCursor(0, 20);
    display.printf("Channel: %d", channel);
    display.setCursor(0, 40);
    display.printf("Distance: %d mm", distance);
    display.display();
    delay(2000); // 显示2秒

  } else {
    Serial.println("Sensor not ready for manual measurement");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  // 初始化引脚
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);

  setRGB(1, 0, 0); // 红灯亮
  Wire.begin(SDA_PIN, SCL_PIN);

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
  display.println("SEBT Host - Wired");
  display.println("USB + BLE Mode");
  display.display();
  delay(2000);

  // BLE初始化
  initBLE();

  // 传感器初始化
  display.clearDisplay();
  display.setCursor(0, 0);
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
    delay(200);
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("System Ready!");
  display.setCursor(0, 20);
  display.println("USB: Connected");
  display.setCursor(0, 40);
  display.println("BLE: Waiting...");
  display.display();

  Serial.println("=== SEBT Host Ready ===");
  Serial.println("Communication channels:");
  Serial.println("- USB Serial: Connected to PC");
  Serial.println("- BLE: Waiting for slave connection");
  Serial.println("========================");
}

void loop() {
  // --- 0. BLE连接状态管理 ---
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
    Serial.println("BLE slave connected, ready for data exchange");
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("System Ready!");
    display.setCursor(0, 20);
    display.println("USB: Connected");
    display.setCursor(0, 40);
    display.println("BLE: Connected");
    display.display();
  }

  if (!deviceConnected && oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
    Serial.println("BLE slave disconnected");
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("System Ready!");
    display.setCursor(0, 20);
    display.println("USB: Connected");
    display.setCursor(0, 40);
    display.println("BLE: Waiting...");
    display.display();
  }

  // --- 1. 处理来自PC的命令 ---
  processPCCommand();

  // --- 2. 按钮复位逻辑 ---
  if (digitalRead(PIN_BTN) == LOW) {
    isLocked = false;
    lastCandidateIndex = -1;
    setRGB(deviceConnected ? 0 : 1, deviceConnected ? 1 : 0, 0); // BLE连接时绿灯，否则红灯
    display.clearDisplay();
    display.setCursor(0, 20);
    display.setTextSize(2);
    display.println("RESET...");
    display.display();
    delay(500);
    return;
  }

  // --- 3. 传感器扫描 ---
  minDistance = 9999;
  minIndex = -1;

  for (int i = 0; i < 8; i++) {
    tcaSelect(i);

    if (vl53.dataReady()) {
      int d = vl53.distance();
      if (d == -1) d = 9999;
      distances[i] = d;
      vl53.clearInterrupt();
    }

    if (distances[i] > FILTER_MIN_MM && distances[i] < FILTER_MAX_MM) {
      if (distances[i] < minDistance) {
        minDistance = distances[i];
        minIndex = i;
      }
    }
  }

  // --- 4. 锁定判断逻辑 ---
  if (!isLocked) {
    // 根据BLE连接状态设置LED
    if (deviceConnected) {
      setRGB(0, 1, 0); // 绿灯 (BLE已连接)
    } else {
      setRGB(1, 0, 0); // 红灯 (BLE未连接)
    }

    if (minIndex != -1) {
      if (minIndex == lastCandidateIndex) {
        if (millis() - stableStartTime > STABLE_TIME_MS) {
          isLocked = true;
          setRGB(0, 0, 1); // 蓝灯 (锁定!)

          // 发送锁定事件到PC
          sendSensorDataToPC(lastCandidateIndex, distances[lastCandidateIndex]);
          Serial.println("Target locked and data sent to PC");
        }
      } else {
        lastCandidateIndex = minIndex;
        stableStartTime = millis();
      }
    } else {
      lastCandidateIndex = -1;
    }
  }

  // --- 5. 定期发送传感器数据到PC ---
  static unsigned long lastDataSend = 0;
  if (millis() - lastDataSend >= 1000) { // 每秒发送一次
    if (minIndex != -1) {
      sendSensorDataToPC(minIndex, minDistance);
    }
    lastDataSend = millis();
  }

  // --- 6. OLED 显示逻辑 ---
  display.clearDisplay();

  if (isLocked) {
    // === 锁定状态 ===
    display.setCursor(0, 0);
    display.setTextSize(1);
    display.println("Target Locked:");

    display.setTextSize(2);
    display.setCursor(0, 16);
    display.println(DIR_NAMES[lastCandidateIndex]);

    display.setTextSize(3);
    display.setCursor(0, 40);
    display.print(distances[lastCandidateIndex]);
    display.setTextSize(1);
    display.print(" mm");

    // 显示连接状态
    display.setCursor(80, 0);
    display.setTextSize(1);
    if (deviceConnected) {
      display.println("BLE:OK");
    } else {
      display.println("BLE:--");
    }

  } else {
    // === 扫描状态 ===
    display.setCursor(0, 0);
    display.setTextSize(1);
    display.println("Scanning...");

    if (minIndex != -1) {
      display.setCursor(0, 20);
      display.print("Nearest: ");
      display.println(DIR_NAMES[minIndex]);

      display.setCursor(0, 35);
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

    // 显示连接状态
    display.setCursor(80, 0);
    display.setTextSize(1);
    if (deviceConnected) {
      display.println("BLE:OK");
    } else {
      display.println("BLE:--");
    }
  }

  display.display(); // 刷新屏幕

  delay(100); // 控制循环频率
}
