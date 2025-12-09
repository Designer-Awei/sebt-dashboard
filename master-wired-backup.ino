/*
 * SEBT Host - 简化测距版本 (参考原始代码)
 * 硬件：ESP32-C3, TCA9548A, 8x VL53L1X, SH1106 OLED
 * 通信：USB串口(与PC)
 * 功能：距离测量 + 3秒锁定 + 串口数据传输
 */

#include <Wire.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <Adafruit_VL53L1X.h>

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

// --- 2. 全局变量 ---

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

// 数据包序号
int packetSequence = 0;

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



// --- 发送传感器数据到PC ---
void sendSensorDataToPC(int directionIndex, int distance) {
  // 构建包含8个方向距离的完整数据包
  String data = "{";
  data += "\"sequence\":" + String(packetSequence++) + ",";
  data += "\"timestamp\":" + String(millis()) + ",";
  data += "\"distances\":[";

  // 添加8个方向的距离数据
  for (int i = 0; i < 8; i++) {
    data += String(distances[i]);
    if (i < 7) data += ",";
  }
  data += "],";

  data += "\"currentMinDirection\":" + String(directionIndex) + ",";
  data += "\"currentMinDistance\":" + String(distance) + ",";
  data += "\"isLocked\":" + String(isLocked ? "true" : "false");
  data += "}";

  // 使用简单的文本协议发送数据
  Serial.print("DATA:");
  Serial.println(data);

  // 调试信息 (只在锁定状态时输出，避免刷屏)
  if (isLocked) {
    Serial.print("[DATA] 发送锁定数据包: ");
    Serial.println(data);
  }
}


// --- 处理来自PC的命令 ---
void processPCCommand() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command.length() > 0) {
      Serial.print("[CMD] 收到命令: ");
      Serial.println(command);

      // 检查是否是手动测距命令
      if (command.startsWith("MEASURE:")) {
        int channel = command.substring(8).toInt(); // 提取通道号
        performManualMeasurement(channel);
      } else if (command.startsWith("RESET")) {
        // 复位命令
        isLocked = false;
        lastCandidateIndex = -1;
        Serial.println("[CMD] 系统复位");
      } else {
        Serial.println("[CMD] 未知命令");
      }
    }
  }
}

// --- 执行手动测距 ---
void performManualMeasurement(int channel) {
  if (channel >= 0 && channel < 8) {
    Serial.printf("[MEASURE] 手动测距方向: %s\n", DIR_NAMES[channel]);

    // 切换到指定通道
    tcaSelect(channel);

    // 读取距离数据
    if (vl53.dataReady()) {
      int distance = vl53.distance();
      vl53.clearInterrupt();

      if (distance == -1) distance = 9999; // 处理无效数据

      // 发送测距结果到PC
      sendSensorDataToPC(channel, distance);
      Serial.printf("[MEASURE] 测距结果: %d mm\n", distance);
    } else {
      Serial.println("[MEASURE] 传感器未准备就绪");
    }
  } else {
    Serial.println("[MEASURE] 无效的方向编号");
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
  display.setRotation(0); // 确保屏幕方向正确 (0=正常, 2=180度旋转)
  display.setCursor(0,0);
  display.println("SEBT Host - Wired");
  display.println("USB Mode");
  display.display();
  delay(2000);

  // 传感器初始化
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Init Sensors...");
  display.display();

  for (int i = 0; i < 8; i++) {
    tcaSelect(i);
    display.printf("S%d: ", i);

    // 尝试初始化传感器，最多重试3次
    bool sensorOK = false;
    for (int retry = 0; retry < 3; retry++) {
      if (vl53.begin(0x29, &Wire)) {
        vl53.startRanging();
        vl53.setTimingBudget(50); // 高速模式
        sensorOK = true;
        break;
      }
      delay(100);
    }

    if (sensorOK) {
      display.println("OK");
      Serial.printf("Sensor %d ready\n", i);
    } else {
      display.println("FAIL");
      Serial.printf("Sensor %d init failed after 3 retries\n", i);
      // 即使失败也继续，但会影响该方向的测量
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
  display.println("BLE: Optional");
  display.display();

  Serial.println("=== SEBT Host Ready ===");
  Serial.println("Core Features:");
  Serial.println("- 8-direction distance measurement");
  Serial.println("- 3-second target locking");
  Serial.println("- Real-time data upload via USB");
  Serial.println("- Manual measurement commands");
  Serial.println("========================");

  // 发送启动确认信息到PC
  Serial.println("[STARTUP] SEBT Host initialization complete");
  Serial.println("[STARTUP] Ready for distance measurement and data transmission");
}

void loop() {
  // --- 0. 处理来自PC的命令 ---
  processPCCommand();

  // --- 2. 按钮复位逻辑 ---
  if (digitalRead(PIN_BTN) == LOW) {
    isLocked = false;
    lastCandidateIndex = -1;
    setRGB(1, 0, 0); // 红灯 (复位状态)
    display.clearDisplay();
    display.setCursor(0, 20);
    display.setTextSize(2);
    display.println("RESET...");
    display.display();
    delay(500);

    // 发送一个测试数据包确认串口通信正常
    Serial.println("[RESET] 系统复位，串口通信正常");
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

      // 调试信息：只在第一次扫描时输出，避免刷屏
      static bool firstScan = true;
      if (firstScan && i == 0) {
        Serial.printf("[SCAN] Direction %d: %d mm\n", i, d);
        if (i == 7) firstScan = false;
      }
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
    setRGB(1, 0, 0); // 红灯 (扫描中)

    if (minIndex != -1) {
      if (minIndex == lastCandidateIndex) {
        if (millis() - stableStartTime > STABLE_TIME_MS) {
          isLocked = true;
          setRGB(0, 0, 1); // 蓝灯 (锁定!)

          // 发送锁定事件到PC
          sendSensorDataToPC(lastCandidateIndex, distances[lastCandidateIndex]);
          Serial.println("[LOCK] 目标锁定，数据已发送到PC");
        }
      } else {
        lastCandidateIndex = minIndex;
        stableStartTime = millis();
      }
    } else {
      lastCandidateIndex = -1;
    }
  }

  // --- 5. 定期发送实时数据到PC (每秒一次) ---
  static unsigned long lastDataSend = 0;
  if (millis() - lastDataSend >= 1000) { // 每秒发送一次当前状态
    // 总是发送数据，即使没有有效目标（用于测试通信）
    if (minIndex != -1) {
      sendSensorDataToPC(minIndex, minDistance);
      Serial.printf("[DATA] 发送扫描数据 - 方向:%d, 距离:%d mm\n", minIndex, minDistance);
    } else {
      // 发送无目标的数据包
      sendSensorDataToPC(-1, 9999);
      Serial.println("[DATA] 发送无目标数据包");
    }
    lastDataSend = millis();
  }

  // --- 5. OLED 显示逻辑 ---
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
    display.print(distances[lastCandidateIndex]); // 实时更新距离
    display.setTextSize(1);
    display.print(" mm");

    // 显示连接状态
    display.setCursor(80, 0);
    display.setTextSize(1);
    display.println("USB:OK");

  } else {
    // === 扫描状态 (实时显示最近端) ===
    display.setCursor(0, 0);
    display.setTextSize(1);
    display.println("Scanning...");

    if (minIndex != -1) {
      // 实时显示当前的最近方向和距离
      display.setCursor(0, 20);
      display.print("Nearest: ");
      display.println(DIR_NAMES[minIndex]); // 实时更新方向

      display.setCursor(0, 35);
      display.setTextSize(2);
      display.print(minDistance); display.print(" mm"); // 实时更新数值

      // 显示进度条 (可视化 3秒 倒计时)
      // 只有当持续对准同一方向时，进度条才会增长
      if (lastCandidateIndex != -1 && minIndex == lastCandidateIndex) {
        long elapsed = millis() - stableStartTime;
        int barWidth = map(elapsed, 0, STABLE_TIME_MS, 0, 128); // 映射到 0-128像素宽度
        if (barWidth > 128) barWidth = 128;

        // 绘制空心框
        display.drawRect(0, 55, 128, 6, SH110X_WHITE);
        // 绘制实心进度
        display.fillRect(0, 55, barWidth, 6, SH110X_WHITE);
      }
    } else {
      display.setCursor(0, 25);
      display.println("No Object");
    }

    // 显示连接状态
    display.setCursor(80, 0);
    display.setTextSize(1);
    display.println("USB:OK");
  }

  display.display(); // 刷新屏幕

  delay(100); // 控制循环频率
}
